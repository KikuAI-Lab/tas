# Функция для проверки наличия команды
function Test-Command($cmdname) {
    return [bool](Get-Command -Name $cmdname -ErrorAction SilentlyContinue)
}

# Проверка наличия прав администратора
if (-NOT ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    Write-Warning "Запустите скрипт от имени администратора для корректной работы."
    Exit
}

# Проверка и установка Chocolatey
if (-not (Test-Command choco)) {
    Write-Host "Установка Chocolatey..."
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://chocolatey.org/install.ps1'))
    refreshenv
} else {
    Write-Host "Chocolatey уже установлен."
}

# Установка Git
if (-not (Test-Command git)) {
    Write-Host "Установка Git..."
    choco install git -y
    refreshenv
} else {
    Write-Host "Git уже установлен."
}

# Установка Heroku CLI
if (-not (Test-Command heroku)) {
    Write-Host "Установка Heroku CLI..."
    choco install heroku-cli -y
    refreshenv
} else {
    Write-Host "Heroku CLI уже установлен."
}

# Проверка установки и вывод версий
Write-Host "`nПроверка установленных версий:"
if (Test-Command git) {
    Write-Host "Git версия:"
    git --version
} else {
    Write-Warning "Git не был успешно установлен."
}

if (Test-Command heroku) {
    Write-Host "`nHeroku CLI версия:"
    heroku --version
} else {
    Write-Warning "Heroku CLI не был успешно установлен."
}

Write-Host "`nУстановка завершена. Перезапустите PowerShell для применения изменений в PATH."