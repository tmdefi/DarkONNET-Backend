// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "fhevm/FHE.sol";
import {CoprocessorSetup} from "./CoprocessorSetup.sol";

interface IEncryptedERC20 {
    function transferFrom(address from, address to, euint64 amount) external returns (bool);
    function transfer(address to, euint64 amount) external returns (bool);
}

contract ConfidentialPredictionMarket {
    IEncryptedERC20 public cUSDT;

    struct Market {
        uint256 id; // Universal ID (Match ID for Esports, Question Hash for Politics)
        string category; // "Esports", "Politics", "Crypto", etc.
        string description; // "T1 vs G2" or "Will Candidate X win?"
        euint64 totalBetsOutcomeA;
        euint64 totalBetsOutcomeB;
        bool isSettled;
        uint8 winningOutcome;
        bool isCanceled;
        bool exists;
    }

    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => euint64)) private userBetsOutcomeA;
    mapping(uint256 => mapping(address => euint64)) private userBetsOutcomeB;

    struct PendingClaim {
        uint256 marketId;
        bytes32 numeratorHandle;
        bytes32 denominatorHandle;
        bool exists;
    }
    mapping(address => PendingClaim) public pendingClaims;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    struct PendingExit {
        uint256 marketId;
        uint8 outcome;
        euint64 userBet;
        bytes32 numeratorHandle;
        bytes32 denominatorHandle;
        bool exists;
    }
    mapping(address => PendingExit) public pendingExits;

    address public owner;

    event MarketCreated(uint256 indexed id, string category, string description);
    event BetPlaced(address indexed user, uint256 indexed marketId, uint8 outcome);
    event MarketSettled(uint256 indexed marketId, uint8 winner);
    event MarketCanceled(uint256 indexed marketId);
    event ClaimRequested(address indexed user, uint256 indexed marketId);
    event PayoutDistributed(address indexed user, uint256 indexed marketId, uint256 amount);
    event PnLUpdated(
        address indexed user, uint256 indexed marketId, bytes32 numeratorHandle, bytes32 denominatorHandle
    );
    event ExitRequested(
        address indexed user,
        uint256 indexed marketId,
        uint8 outcome,
        bytes32 numeratorHandle,
        bytes32 denominatorHandle
    );
    event PositionExited(address indexed user, uint256 indexed marketId, uint8 outcome);
    event VolumeGaugeUpdated(uint256 indexed marketId, bytes32 gaugeHandle);

    constructor(address _cUSDTAddress) {
        FHE.setCoprocessor(CoprocessorSetup.defaultConfig());
        owner = msg.sender;
        cUSDT = IEncryptedERC20(_cUSDTAddress);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Only owner");
        _;
    }

    function createMarket(uint256 _id, string memory _category, string memory _description) public onlyOwner {
        require(!markets[_id].exists, "Market already exists");

        markets[_id] = Market({
            id: _id,
            category: _category,
            description: _description,
            totalBetsOutcomeA: FHE.asEuint64(0),
            totalBetsOutcomeB: FHE.asEuint64(0),
            isSettled: false,
            winningOutcome: 0,
            isCanceled: false,
            exists: true
        });

        emit MarketCreated(_id, _category, _description);
    }

    function bet(uint256 _marketId, uint8 _outcome, bytes calldata encryptedValue, bytes calldata proof) public {
        Market storage m = markets[_marketId];
        require(m.exists, "Market not found");
        require(!m.isSettled, "Market settled");
        require(!pendingExits[msg.sender].exists, "Pending exit");
        require(_outcome == 0 || _outcome == 1, "Invalid outcome");

        // casting to bytes32 is safe because externalEuint64 is represented as a bytes32 encrypted handle.
        // forge-lint: disable-next-line(unsafe-typecast)
        euint64 value = FHE.fromExternal(externalEuint64.wrap(bytes32(encryptedValue)), proof);
        FHE.allow(value, address(cUSDT));
        require(cUSDT.transferFrom(msg.sender, address(this), value), "cUSDT transfer failed");

        if (_outcome == 0) {
            userBetsOutcomeA[_marketId][msg.sender] = FHE.add(userBetsOutcomeA[_marketId][msg.sender], value);
            m.totalBetsOutcomeA = FHE.add(m.totalBetsOutcomeA, value);
        } else {
            userBetsOutcomeB[_marketId][msg.sender] = FHE.add(userBetsOutcomeB[_marketId][msg.sender], value);
            m.totalBetsOutcomeB = FHE.add(m.totalBetsOutcomeB, value);
        }

        // Grant the user permission to see only their own position
        FHE.allow(userBetsOutcomeA[_marketId][msg.sender], msg.sender);
        FHE.allow(userBetsOutcomeB[_marketId][msg.sender], msg.sender);

        emit BetPlaced(msg.sender, _marketId, _outcome);
    }

    /**
     * @notice Requests an updated PnL snapshot.
     * @dev Requests decryption handles for (Bet * TotalPool) / OutcomePool.
     *      fhEVM only supports encrypted division by plaintext scalars, so the frontend
     *      must public-decrypt both handles and perform the final division off-chain.
     */
    function requestPnLUpdate(uint256 _marketId, uint8 _outcome) public {
        Market storage m = markets[_marketId];
        require(m.exists, "Market not found");

        euint64 userBet =
            (_outcome == 0) ? userBetsOutcomeA[_marketId][msg.sender] : userBetsOutcomeB[_marketId][msg.sender];
        euint64 outcomePool = (_outcome == 0) ? m.totalBetsOutcomeA : m.totalBetsOutcomeB;
        euint64 totalPool = FHE.add(m.totalBetsOutcomeA, m.totalBetsOutcomeB);

        euint64 numerator = FHE.mul(userBet, totalPool);

        FHE.makePubliclyDecryptable(numerator);
        FHE.makePubliclyDecryptable(outcomePool);

        emit PnLUpdated(msg.sender, _marketId, FHE.toBytes32(numerator), FHE.toBytes32(outcomePool));
    }

    /**
     * @notice Requests an early exit quote for the user's full position on one outcome.
     * @dev Locks the current position, removes it from the active pool, and emits public
     *      decryption handles for the fair-value numerator and denominator.
     * @param _marketId The ID of the market
     * @param _outcome The outcome the user is betting on (0 or 1)
     */
    function requestExitPosition(uint256 _marketId, uint8 _outcome) public {
        Market storage m = markets[_marketId];
        require(m.exists && !m.isSettled, "Invalid market state");
        require(_outcome == 0 || _outcome == 1, "Invalid outcome");
        require(!pendingExits[msg.sender].exists, "Pending exit");

        euint64 userBet =
            (_outcome == 0) ? userBetsOutcomeA[_marketId][msg.sender] : userBetsOutcomeB[_marketId][msg.sender];
        euint64 outcomePool = (_outcome == 0) ? m.totalBetsOutcomeA : m.totalBetsOutcomeB;
        euint64 totalPool = FHE.add(m.totalBetsOutcomeA, m.totalBetsOutcomeB);
        euint64 numerator = FHE.mul(userBet, totalPool);

        if (_outcome == 0) {
            userBetsOutcomeA[_marketId][msg.sender] = FHE.asEuint64(0);
            m.totalBetsOutcomeA = FHE.sub(m.totalBetsOutcomeA, userBet);
        } else {
            userBetsOutcomeB[_marketId][msg.sender] = FHE.asEuint64(0);
            m.totalBetsOutcomeB = FHE.sub(m.totalBetsOutcomeB, userBet);
        }

        FHE.allowThis(userBet);
        FHE.makePubliclyDecryptable(numerator);
        FHE.makePubliclyDecryptable(outcomePool);

        pendingExits[msg.sender] = PendingExit({
            marketId: _marketId,
            outcome: _outcome,
            userBet: userBet,
            numeratorHandle: FHE.toBytes32(numerator),
            denominatorHandle: FHE.toBytes32(outcomePool),
            exists: true
        });

        emit ExitRequested(msg.sender, _marketId, _outcome, FHE.toBytes32(numerator), FHE.toBytes32(outcomePool));
    }

    /**
     * @notice Completes a previously requested early exit.
     * @dev Verifies KMS decryption proof, calculates fair value minus a 1% fee,
     *      and returns the payout as encrypted cUSDT.
     */
    function fulfillExitPosition(bytes memory abiEncodedCleartexts, bytes memory decryptionProof) public {
        PendingExit memory exitReq = pendingExits[msg.sender];
        require(exitReq.exists, "No pending exit");

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = exitReq.numeratorHandle;
        handles[1] = exitReq.denominatorHandle;

        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);

        (uint64 decodedNumerator, uint64 decodedDenominator) = abi.decode(abiEncodedCleartexts, (uint64, uint64));
        uint64 fairValue = decodedDenominator > 0 ? uint64(decodedNumerator / decodedDenominator) : 0;
        uint64 netExitValue = fairValue - (fairValue / 100);

        delete pendingExits[msg.sender];

        euint64 encryptedPayout = FHE.asEuint64(netExitValue);
        FHE.allow(encryptedPayout, address(cUSDT));
        require(cUSDT.transfer(msg.sender, encryptedPayout), "cUSDT exit transfer failed");

        emit PositionExited(msg.sender, exitReq.marketId, exitReq.outcome);
    }

    function settle(uint256 _marketId, uint8 _winner, bool _isCanceled) public onlyOwner {
        Market storage m = markets[_marketId];
        require(m.exists && !m.isSettled, "Invalid market state");

        m.isCanceled = _isCanceled;
        if (!_isCanceled) {
            m.winningOutcome = _winner;
        }

        m.isSettled = true;

        if (m.isCanceled) {
            emit MarketCanceled(_marketId);
        } else {
            emit MarketSettled(_marketId, _winner);
        }
    }

    function requestClaim(uint256 _marketId) public {
        Market storage m = markets[_marketId];
        require(m.isSettled, "Not settled");
        require(!hasClaimed[_marketId][msg.sender], "Already claimed");

        euint64 userNumerator;
        euint64 denominator;

        if (m.isCanceled) {
            userNumerator = FHE.add(userBetsOutcomeA[_marketId][msg.sender], userBetsOutcomeB[_marketId][msg.sender]);
            denominator = FHE.asEuint64(1);
        } else {
            euint64 userWinningBet = m.winningOutcome == 0
                ? userBetsOutcomeA[_marketId][msg.sender]
                : userBetsOutcomeB[_marketId][msg.sender];
            denominator = m.winningOutcome == 0 ? m.totalBetsOutcomeA : m.totalBetsOutcomeB;
            euint64 totalPool = FHE.add(m.totalBetsOutcomeA, m.totalBetsOutcomeB);
            userNumerator = FHE.mul(userWinningBet, totalPool);
        }

        FHE.makePubliclyDecryptable(userNumerator);
        FHE.makePubliclyDecryptable(denominator);

        pendingClaims[msg.sender] = PendingClaim({
            marketId: _marketId,
            numeratorHandle: FHE.toBytes32(userNumerator),
            denominatorHandle: FHE.toBytes32(denominator),
            exists: true
        });

        emit ClaimRequested(msg.sender, _marketId);
    }

    function fulfillClaim(bytes memory abiEncodedCleartexts, bytes memory decryptionProof) public {
        PendingClaim memory claimReq = pendingClaims[msg.sender];
        require(claimReq.exists, "No pending claim");

        bytes32[] memory handles = new bytes32[](2);
        handles[0] = claimReq.numeratorHandle;
        handles[1] = claimReq.denominatorHandle;

        FHE.checkSignatures(handles, abiEncodedCleartexts, decryptionProof);

        (uint64 decodedNumerator, uint64 decodedDenominator) = abi.decode(abiEncodedCleartexts, (uint64, uint64));
        uint64 payout = decodedDenominator > 0 ? uint64(decodedNumerator / decodedDenominator) : 0;

        uint256 marketId = claimReq.marketId;
        hasClaimed[marketId][msg.sender] = true;
        delete pendingClaims[msg.sender];

        euint64 encryptedPayout = FHE.asEuint64(payout);
        FHE.allow(encryptedPayout, address(cUSDT));
        require(cUSDT.transfer(msg.sender, encryptedPayout), "cUSDT payout transfer failed");

        emit PayoutDistributed(msg.sender, marketId, uint256(payout));
    }

    function getMarketInfo(uint256 _id)
        public
        view
        returns (
            uint256 id,
            string memory category,
            string memory description,
            bool isSettled,
            uint8 winningOutcome,
            bool isCanceled,
            bool exists
        )
    {
        Market storage m = markets[_id];
        return (m.id, m.category, m.description, m.isSettled, m.winningOutcome, m.isCanceled, m.exists);
    }

    function getMyPosition(uint256 _marketId, uint8 outcome) public view returns (euint64) {
        if (outcome == 0) return userBetsOutcomeA[_marketId][msg.sender];
        return userBetsOutcomeB[_marketId][msg.sender];
    }

    /**
     * @notice Returns the handles for the total bets in each pool.
     * @dev Use these handles with fhevmjs on the frontend for decryption requests.
     */
    function getPoolHandles(uint256 _marketId) public view returns (bytes32 handleA, bytes32 handleB) {
        Market storage m = markets[_marketId];
        return (FHE.toBytes32(m.totalBetsOutcomeA), FHE.toBytes32(m.totalBetsOutcomeB));
    }

    /**
     * @notice Calculates a 0-100 gauge value for pool volume relative to a target.
     * @dev Only the 0-100 result is made publicly decryptable, keeping absolute volume confidential.
     * @param _marketId The ID of the market
     * @param _maxExpected The target volume (e.g., 10000) that represents 100% on the gauge
     */
    function requestVolumeGauge(uint256 _marketId, uint64 _maxExpected) public {
        Market storage m = markets[_marketId];
        require(m.exists, "Market not found");
        require(_maxExpected > 0, "Invalid max expected");

        euint64 total = FHE.add(m.totalBetsOutcomeA, m.totalBetsOutcomeB);

        // Gauge = (total * 100) / maxExpected
        euint64 gauge = FHE.div(FHE.mul(total, uint64(100)), _maxExpected);

        // Cap at 100
        euint64 cappedGauge = FHE.select(FHE.gt(gauge, uint64(100)), FHE.asEuint64(100), gauge);

        FHE.makePubliclyDecryptable(cappedGauge);
        emit VolumeGaugeUpdated(_marketId, FHE.toBytes32(cappedGauge));
    }
}
