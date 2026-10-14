Set oShell = CreateObject("WScript.Shell")
Set oEnv = oShell.Environment("Process")
Set fso = CreateObject("Scripting.FileSystemObject")
port = "9222"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)
If oEnv("TV_COMPATIBILITY_CHILD") <> "1" Then
    helper = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "compatibility-launch.js")
    code = oShell.Run("node """ & helper & """ """ & WScript.ScriptFullName & """ " & port, 1, True)
    WScript.Quit code
End If
oEnv("ELECTRON_EXTRA_LAUNCH_ARGS") = "--remote-debugging-port=" & port
oShell.Run "explorer.exe shell:AppsFolder\TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop", 1, False
For attempt = 1 To 30
    code = oShell.Run("curl --fail --silent --max-time 2 http://127.0.0.1:" & port & "/json/version -o """ & oEnv("TV_COMPATIBILITY_RESPONSE_FILE") & """", 0, True)
    If code = 0 Then WScript.Quit 0
    WScript.Sleep 1000
Next
WScript.Echo "CDP did not become ready; compatibility was not verified."
WScript.Quit 1
