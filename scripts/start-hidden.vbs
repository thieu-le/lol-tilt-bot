' Launches lol-tilt-bot via node with no visible console window.
' Used by the Task Scheduler entry created by install-autostart-win.ps1.
Set fso = CreateObject("Scripting.FileSystemObject")
Set wsh = CreateObject("WScript.Shell")
botDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
wsh.CurrentDirectory = botDir
wsh.Run "node " & botDir & "\src\index.js", 0, False
