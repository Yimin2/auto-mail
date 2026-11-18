' Windows Task Scheduler entry: run "node run.mjs" (same folder) hidden, without a console window
Dim fso, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run "node """ & dir & "\run.mjs""", 0, False
