# Takes one JSON line from stdin; only DPAPI ciphertext is written, never plaintext.
param([Parameter(Mandatory=$true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Security
  $qqConfigLine = [Console]::ReadLine()
  if (!$qqConfigLine -or $qqConfigLine.Length -gt 8192) { throw 'Invalid configuration' }
  $qqConfigObject = $qqConfigLine | ConvertFrom-Json
  foreach ($qqConfigKey in 'QQ_APP_ID','QQ_APP_SECRET','QQ_SCOPE_ID','QQ_PSEUDONYM_KEY','QQ_RECIPIENT_OPENID') {
    if (![string]$qqConfigObject.$qqConfigKey) { throw 'Missing configuration' }
  }
  $qqConfigTarget = [IO.Path]::GetFullPath($OutputPath)
  if ([IO.File]::Exists($qqConfigTarget)) { throw 'Existing configuration must be preserved' }
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($qqConfigTarget)) | Out-Null
  $qqConfigPlain = [Text.Encoding]::UTF8.GetBytes($qqConfigLine)
  $qqConfigCipher = [Security.Cryptography.ProtectedData]::Protect($qqConfigPlain,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser)
  [IO.File]::WriteAllBytes($qqConfigTarget,$qqConfigCipher)
  [Array]::Clear($qqConfigPlain,0,$qqConfigPlain.Length)
  $qqConfigLine = $null
  Write-Output '{"protected":true}'
} catch {
  [Console]::Error.WriteLine('QQ_PROTECT_CONFIG_FAILED')
  exit 1
}
