# Load .env file variables into the current session
if (Test-Path .env) {
    Get-Content .env | Foreach-Object {
        if ($_ -match "=" -and -not $_.StartsWith("#")) {
            $name, $value = $_.Split('=', 2)
            $name = $name.Trim()
            $value = $value.Trim()
            [System.Environment]::SetEnvironmentVariable($name, $value, "Process")
            Write-Host "Loaded environment variable: $name" -ForegroundColor Cyan
        }
    }
} else {
    Write-Error ".env file not found! Please create it based on .env.example"
    exit
}

# Run the deployment
if ($env:INFURA_API_KEY) {
    if ($env:INFURA_API_KEY -match '^https?://') {
        Write-Error "INFURA_API_KEY should contain only the API key, not the full Infura URL."
        exit
    }

    $rpcUrl = "https://sepolia.infura.io/v3/$($env:INFURA_API_KEY)"
} else {
    $rpcUrl = "https://ethereum-sepolia-rpc.publicnode.com"
}

Write-Host "Starting deployment to Sepolia..." -ForegroundColor Green
./forge.exe script script/DeployPredictionMarket.s.sol --rpc-url $rpcUrl --broadcast

Write-Host "Deployment process finished." -ForegroundColor Green
