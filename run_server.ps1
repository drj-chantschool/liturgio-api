Set-Location -Path $PSScriptRoot
& "C:\Users\johna\liturgio\.venv\Scripts\python.exe" -m uvicorn app:app --reload --host 127.0.0.1 --port 8000 *>> "$PSScriptRoot\server.log"
