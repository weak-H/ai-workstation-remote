param(
  [Parameter(Position = 0, Mandatory = $true)]
  [ValidateSet("status", "activate", "open-ide", "submit")]
  [string]$Command,

  [Parameter(Position = 1)]
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class CursorInputNative {
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const ushort VK_RETURN = 0x0D;
    private const int SW_RESTORE = 9;

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr hWnd, int command);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")]
    private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    private static bool IsCursorWindow(IntPtr window) {
        if (!IsWindowVisible(window)) return false;
        GetWindowThreadProcessId(window, out uint pid);
        try {
            return String.Equals(Process.GetProcessById((int)pid).ProcessName, "Cursor", StringComparison.OrdinalIgnoreCase);
        } catch {
            return false;
        }
    }

    private static string WindowTitle(IntPtr window) {
        var title = new StringBuilder(1024);
        GetWindowText(window, title, title.Capacity);
        return title.ToString();
    }

    private static IntPtr FindWindow(string hint) {
        IntPtr first = IntPtr.Zero;
        IntPtr matched = IntPtr.Zero;
        EnumWindows((window, _) => {
            if (!IsCursorWindow(window)) return true;
            if (first == IntPtr.Zero) first = window;
            if (!String.IsNullOrWhiteSpace(hint) && WindowTitle(window).IndexOf(hint, StringComparison.OrdinalIgnoreCase) >= 0) {
                matched = window;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return matched != IntPtr.Zero ? matched : first;
    }

    public static bool Activate(string hint) {
        IntPtr window = FindWindow(hint ?? "");
        if (window == IntPtr.Zero) return false;
        IntPtr foreground = GetForegroundWindow();
        uint currentThread = GetCurrentThreadId();
        uint foregroundPid;
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out foregroundPid);
        bool attached = foregroundThread != 0 && foregroundThread != currentThread
            && AttachThreadInput(currentThread, foregroundThread, true);
        ShowWindowAsync(window, SW_RESTORE);
        BringWindowToTop(window);
        bool activated = SetForegroundWindow(window) || GetForegroundWindow() == window;
        if (attached) AttachThreadInput(currentThread, foregroundThread, false);
        return activated;
    }

    public static bool CursorIsForeground() {
        IntPtr window = GetForegroundWindow();
        return window != IntPtr.Zero && IsCursorWindow(window);
    }

    private static INPUT Key(ushort virtualKey, ushort scanCode, uint flags) {
        return new INPUT {
            type = INPUT_KEYBOARD,
            data = new InputUnion {
                keyboard = new KEYBDINPUT {
                    virtualKey = virtualKey,
                    scanCode = scanCode,
                    flags = flags,
                    time = 0,
                    extraInfo = UIntPtr.Zero
                }
            }
        };
    }

    public static void Submit(string text) {
        foreach (char character in text) {
            var inputs = new[] {
                Key(0, character, KEYEVENTF_UNICODE),
                Key(0, character, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)
            };
            if (SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))) != (uint)inputs.Length) {
                throw new InvalidOperationException("Windows SendInput failed");
            }
        }
        var enter = new[] {
            Key(VK_RETURN, 0, 0),
            Key(VK_RETURN, 0, KEYEVENTF_KEYUP)
        };
        if (SendInput((uint)enter.Length, enter, Marshal.SizeOf(typeof(INPUT))) != (uint)enter.Length) {
            throw new InvalidOperationException("Windows SendInput failed for Enter");
        }
    }
}
"@

function Find-CursorCli {
  $candidates = @(
    $env:CURSOR_BIN,
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\cursor\Cursor.exe" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\Cursor\Cursor.exe" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\cursor\resources\app\bin\cursor.cmd" }),
    $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA "Programs\Cursor\resources\app\bin\cursor.cmd" }),
    "cursor.cmd",
    "cursor.exe"
  ) | Where-Object { $_ }

  foreach ($candidate in $candidates) {
    if ((Test-Path $candidate) -or (Get-Command $candidate -ErrorAction SilentlyContinue)) { return $candidate }
  }
  return $null
}

switch ($Command) {
  "status" {
    Write-Output "ready"
  }
  "activate" {
    if (-not [CursorInputNative]::Activate($Target)) { throw "Cursor 窗口未运行或无法激活" }
    Write-Output "activated"
  }
  "open-ide" {
    $cursor = Find-CursorCli
    if (-not $cursor) { throw "未找到 Cursor CLI" }
    $arguments = if ($Target) { @('"' + $Target.Replace('"', '\"') + '"') } else { @() }
    Start-Process -FilePath $cursor -ArgumentList $arguments | Out-Null
    Write-Output "opened"
  }
  "submit" {
    if (-not [CursorInputNative]::CursorIsForeground()) { throw "输入前台校验失败：当前前台应用不是 Cursor" }
    $text = [Console]::In.ReadToEnd()
    if ($text) { [CursorInputNative]::Submit($text) }
    Write-Output "submitted"
  }
}
