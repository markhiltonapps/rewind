# PowerShell script to start the Python backend with visible output.
# Phase 4 Task 1C: transcription is now Gemini 2.5 Flash (cloud), called
# from the Rust audio pipeline at end-of-recording. The local
# whisper-server.exe is no longer launched here. The binary stays in
# whisper-server-package/ for optional fallback testing — re-add the
# Whisper startup block if needed for offline work.

# Set the port for Python backend (default: 5167)
$port = 5167
if ($args.Count -gt 0) {
    $port = $args[0]
}

Write-Host "====================================="
Write-Host "Neato Rewind Backend Startup"
Write-Host "====================================="
Write-Host "Python Backend Port: $port"
Write-Host "Transcription:       Gemini 2.5 Flash (cloud)"
Write-Host "Summarization:       Gemini 2.5 Flash (cloud)"
Write-Host "====================================="
Write-Host ""

# Kill any existing whisper-server.exe processes from a previous run.
# Whisper isn't started by this script anymore but a stale instance
# from an earlier session would still hold port 8178; clean it up.
$whisperProcesses = Get-Process -Name "whisper-server" -ErrorAction SilentlyContinue
if ($whisperProcesses) {
    Write-Host "Stopping stale Whisper server processes..."
    $whisperProcesses | ForEach-Object { $_.Kill() }
    Start-Sleep -Seconds 1
}

# Kill any existing python.exe processes
$pythonProcesses = Get-Process -Name "python" -ErrorAction SilentlyContinue
if ($pythonProcesses) {
    Write-Host "Stopping existing Python processes..."
    $pythonProcesses | ForEach-Object { $_.Kill() }
    Start-Sleep -Seconds 1
}

# Check if virtual environment exists
if (-not (Test-Path "venv")) {
    Write-Host "Error: Virtual environment not found"
    Write-Host "Please run build_whisper.cmd first"
    exit 1
}

# Check if Python app exists
if (-not (Test-Path "app\main.py")) {
    Write-Host "Error: app\main.py not found"
    exit 1
}

# Sanity-check the GEMINI_API_KEY. The backend itself will surface a
# 503 with a clear message if missing, but flagging at startup avoids
# the user discovering this only after a long meeting recording.
$envFile = ".env"
$keyConfigured = $false
if (Test-Path $envFile) {
    $envContent = Get-Content $envFile -Raw
    if ($envContent -match "^\s*GEMINI_API_KEY\s*=\s*\S") {
        $keyConfigured = $true
    }
}
if (-not $keyConfigured -and -not [string]::IsNullOrWhiteSpace($env:GEMINI_API_KEY)) {
    $keyConfigured = $true
}
if ($keyConfigured) {
    Write-Host "GEMINI_API_KEY: configured"
} else {
    Write-Host "WARNING: GEMINI_API_KEY is not set in backend\.env or environment."
    Write-Host "Transcription and summarization will fail with 503 until configured."
}

Write-Host "====================================="
Write-Host "Starting Neato Rewind Backend"
Write-Host "Python Backend Port: $port"
Write-Host "====================================="
Write-Host ""

# Start Python backend in a new window
Write-Host "Starting Python backend..."
Start-Process -FilePath "cmd.exe" -ArgumentList "/k call venv\Scripts\activate.bat && set PORT=$port && python app\main.py" -WindowStyle Normal

# Wait for Python backend to start
Write-Host "Waiting for Python backend to start..."
Start-Sleep -Seconds 5

# Check if Python backend is running
$pythonRunning = $false
try {
    $pythonProcesses = Get-Process -Name "python" -ErrorAction Stop
    $pythonRunning = $true
    Write-Host "Python backend started with PID: $($pythonProcesses.Id)"
} catch {
    Write-Host "Error: Python backend failed to start"
    exit 1
}

# Check if the service is listening on its port
Write-Host "Checking if Python backend is listening on port $port..."
Start-Sleep -Seconds 5

$pythonListening = $false
$netstatPython = netstat -ano | Select-String -Pattern ":$port.*LISTENING"
if ($netstatPython) {
    $pythonListening = $true
    Write-Host "Python backend is listening on port $port"
} else {
    Write-Host "Warning: Python backend is not listening on port $port"
}

# Final status
Write-Host ""
Write-Host "====================================="
Write-Host "Backend Status"
Write-Host "====================================="
Write-Host "Python Backend:      $(if ($pythonRunning) { "RUNNING" } else { "NOT RUNNING" })"
Write-Host "Python Backend Port: $(if ($pythonListening) { "LISTENING on $port" } else { "NOT LISTENING on $port" })"
Write-Host "Transcription:       Gemini 2.5 Flash (cloud)"
Write-Host "Summarization:       Gemini 2.5 Flash (cloud)"
Write-Host ""
Write-Host "The backend is now running in a separate window."
Write-Host "Close that window to stop the service."
Write-Host "====================================="
