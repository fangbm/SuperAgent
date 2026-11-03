param([ValidateSet('capture','click','rightclick','type','keys','scroll','inspect')][string]$Action = 'capture', [int]$X, [int]$Y, [int]$Delta = -1200, [string]$Text = '', [string]$StepsFile = '', [string]$OutputPath = '.artifacts/discord-desktop/current.png')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DiscordDesktop {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
  [DllImport("user32.dll")] public static extern bool GetPhysicalCursorPos(out POINT point);
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort Vk, Scan; public uint Flags, Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int X,Y; public uint Data,Flags,Time; public UIntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct UNION { [FieldOffset(0)] public KEYBDINPUT Key; [FieldOffset(0)] public MOUSEINPUT Mouse; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint Type; public UNION Data; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint process);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Type(string text) {
    var inputs = new INPUT[text.Length * 2];
    for (int i=0;i<text.Length;i++) {
      inputs[i*2].Type=1; inputs[i*2].Data.Key.Scan=text[i]; inputs[i*2].Data.Key.Flags=4;
      inputs[i*2+1].Type=1; inputs[i*2+1].Data.Key.Scan=text[i]; inputs[i*2+1].Data.Key.Flags=6;
    }
    if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != inputs.Length) throw new Exception("KEY_INPUT_FAILED");
  }
  public static void Scroll(int delta) { mouse_event(0x0800,0,0,unchecked((uint)delta),UIntPtr.Zero); }
}
'@
[void][DiscordDesktop]::SetProcessDPIAware()
if ($StepsFile) { $steps = Get-Content -LiteralPath $StepsFile -Raw -Encoding UTF8 | ConvertFrom-Json }
else { $steps = @(@{ action=$Action; x=$X; y=$Y; text=$Text; delta=$Delta; pause=800 }) }
$stepIndex = 0
foreach ($step in $steps) {
$Action = [string]$step.action
if ($Action -notin @('capture','click','rightclick','type','keys','scroll','inspect')) { throw 'INVALID_DESKTOP_ACTION' }
$X = [int]$step.x; $Y = [int]$step.y; $Text = [string]$step.text
if ($null -ne $step.delta) { $Delta = [int]$step.delta }
$target = Get-Process -Name Discord | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $target) { throw 'DISCORD_WINDOW_NOT_FOUND' }
if ($Action -notin @('capture','inspect') -and $target.MainWindowTitle -notmatch 'Idle Abyss Princesses') { throw 'WRONG_DISCORD_SERVER_CONTEXT' }
$handle = $target.MainWindowHandle
$foregroundProcess = [uint32]0
[void][DiscordDesktop]::GetWindowThreadProcessId([DiscordDesktop]::GetForegroundWindow(), [ref]$foregroundProcess)
if (-not (Get-Process -Name Discord | Where-Object { $_.Id -eq $foregroundProcess })) {
  if ($stepIndex -gt 0) { throw 'DISCORD_LOST_FOCUS' }
  [void][DiscordDesktop]::ShowWindow($handle, 9)
  [void][DiscordDesktop]::SetForegroundWindow($handle)
  Start-Sleep -Milliseconds 250
  [void][DiscordDesktop]::GetWindowThreadProcessId([DiscordDesktop]::GetForegroundWindow(), [ref]$foregroundProcess)
}
if (-not (Get-Process -Name Discord | Where-Object { $_.Id -eq $foregroundProcess })) { throw 'DISCORD_NOT_FOREGROUND' }
$handle = [DiscordDesktop]::GetForegroundWindow()
$rect = New-Object DiscordDesktop+RECT
if (-not [DiscordDesktop]::GetWindowRect($handle, [ref]$rect)) { throw 'WINDOW_BOUNDS_FAILED' }
if ($Action -in @('click','rightclick')) {
  if ($X -lt 0 -or $Y -lt 0 -or $X -ge ($rect.Right-$rect.Left) -or $Y -ge ($rect.Bottom-$rect.Top)) { throw 'CLICK_OUTSIDE_DISCORD' }
  [void][DiscordDesktop]::SetCursorPos($rect.Left+$X, $rect.Top+$Y)
  $down = if ($Action -eq 'rightclick') { 8 } else { 2 }
  $up = if ($Action -eq 'rightclick') { 16 } else { 4 }
  [DiscordDesktop]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  [DiscordDesktop]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
} elseif ($Action -eq 'scroll') {
  [void][DiscordDesktop]::SetCursorPos($rect.Left+$X, $rect.Top+$Y)
  [DiscordDesktop]::Scroll($Delta)
} elseif ($Action -eq 'type') { [DiscordDesktop]::Type($Text) }
elseif ($Action -eq 'keys') { [System.Windows.Forms.SendKeys]::SendWait($Text) }
elseif ($Action -eq 'inspect') {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes
  $root = [Windows.Automation.AutomationElement]::FromHandle($handle)
  $elements = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
  $result = foreach ($element in $elements) {
    try {
      $info = $element.Current; $bounds = $info.BoundingRectangle
      if (-not $info.IsOffscreen -and $info.Name -and $bounds.Left -ge ($rect.Left+120)) {
        @{ name=$info.Name; type=$info.ControlType.ProgrammaticName; x=[int]($bounds.Left-$rect.Left); y=[int]($bounds.Top-$rect.Top); w=[int]$bounds.Width; h=[int]$bounds.Height }
      }
    } catch {}
  }
  $result | Select-Object -First 160 | ConvertTo-Json -Compress
}
$pause = if ($null -ne $step.pause) { [int]$step.pause } else { 600 }
if ($pause -lt 0 -or $pause -gt 5000) { throw 'INVALID_UI_PAUSE' }
Start-Sleep -Milliseconds $pause
$stepIndex++
}
$active = [DiscordDesktop]::GetForegroundWindow()
[void][DiscordDesktop]::GetWindowThreadProcessId($active, [ref]$foregroundProcess)
if (Get-Process -Name Discord | Where-Object { $_.Id -eq $foregroundProcess }) {
  [void][DiscordDesktop]::GetWindowRect($active, [ref]$rect)
}
$path = [IO.Path]::GetFullPath($OutputPath)
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path))
$bitmap = New-Object Drawing.Bitmap ($rect.Right-$rect.Left), ($rect.Bottom-$rect.Top)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
  $bitmap.Save($path,[Drawing.Imaging.ImageFormat]::Png)
} finally { $graphics.Dispose(); $bitmap.Dispose() }
$cursor = New-Object DiscordDesktop+POINT
[void][DiscordDesktop]::GetPhysicalCursorPos([ref]$cursor)
@{ screenshot=$path; width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top; left=$rect.Left; top=$rect.Top; cursorX=$cursor.X; cursorY=$cursor.Y; title=$target.MainWindowTitle } | ConvertTo-Json -Compress
