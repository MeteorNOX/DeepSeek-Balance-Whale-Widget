' DSH Whale Widget - double-click launcher (pure ASCII, path resolved at runtime)
Dim sh, fso, here, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\whale-widget.ps1"""
sh.Run cmd, 0, False
