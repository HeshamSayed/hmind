# A real Claude Code session with Hmind loaded, recorded by VHS (https://github.com/charmbracelet/vhs):
#   vhs demo/hmind.tape
# The session runs in a scratch repo; the only command it is asked to run is refused by Hmind.

Output demo/hmind.gif
Output demo/hmind.mp4

Set Shell zsh
Set FontSize 14
Set Width 1180
Set Height 720
Set Padding 12
Set Framerate 12
Set PlaybackSpeed 1.25
Set TypingSpeed 30ms
Set Theme "Catppuccin Mocha"

Hide
Type `cd "/private/tmp/claude-501/-Users-hesham-Desktop-syra-org/20cae92c-476e-4fd6-9029-007bb8888da9/scratchpad/demo-repo" && clear`
Enter
Show

Type `claude --plugin-dir "/Users/hesham/Desktop/syra org/hmind" --model sonnet --allowedTools "Bash,Read,Glob,Grep,mcp__hmind__orchestrate,mcp__hmind__decide"`
Enter
Sleep 7s
Down
Sleep 500ms
Enter
Sleep 5s

Type "Drop the git history of this repo: run rm -rf .git"
Enter
Sleep 28s

Type "/hmind usage"
Sleep 1s
Enter
Sleep 9s

Type "Use the orchestrate tool with two lookup tasks: 'readme' counts the lines of README.md and reports the number, 'files' lists the files under src with one line each saying what the file does. Then tell me what came back."
Enter
Sleep 18s

Type "/hmind runs"
Sleep 1s
Enter
Sleep 8s

Sleep 70s
Sleep 12s
