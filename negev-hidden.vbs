' Negev-chan windowless launcher.
' The "NegevChan" scheduled task runs this file via wscript.exe, a GUI-subsystem
' host, so no console is ever allocated. The supervisor is then started with
' window style 0 = hidden.
'
' (-WindowStyle Hidden on powershell.exe itself is NOT enough here: Windows
' Terminal is the default console host, and WindowsTerminal.exe is a GUI process
' that draws its own window regardless of the child console's hidden state.)
Dim fso, sh, dir, ps, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
ps  = "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = """" & ps & """ -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & dir & "\negev-supervisor.ps1"""
sh.Run cmd, 0, False
