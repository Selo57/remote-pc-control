using System.Runtime.InteropServices;
using System.Text.Json;
using System.Text.Json.Serialization;

NativeMethods.SetProcessDPIAware();

var enabled = true;
var options = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
};

Console.Error.WriteLine("RemotePc.InputHost ready");
Write(new { type = "ready", metrics = Metrics.Read() });

while (Console.ReadLine() is { } line)
{
    if (string.IsNullOrWhiteSpace(line))
    {
        continue;
    }

    try
    {
        var command = JsonSerializer.Deserialize<InputCommand>(line, options);
        if (command is null)
        {
            continue;
        }

        switch (command.Type)
        {
            case "setEnabled":
                enabled = command.Enabled ?? enabled;
                Write(new { type = "enabled", enabled });
                break;
            case "metrics":
                Write(new { type = "metrics", metrics = Metrics.Read() });
                break;
            default:
                if (!enabled)
                {
                    Write(new { type = "ignored", reason = "disabled" });
                    break;
                }

                InputApplier.Apply(command);
                Write(new { type = "ok", command = command.Type });
                break;
        }
    }
    catch (Exception ex)
    {
        Write(new { type = "error", message = ex.Message });
        Console.Error.WriteLine(ex);
    }
}
static void Write(object value)
{
    Console.WriteLine(JsonSerializer.Serialize(value));
    Console.Out.Flush();
}

sealed class InputCommand
{
    public string Type { get; set; } = "";
    public int? X { get; set; }
    public int? Y { get; set; }
    public int? Dx { get; set; }
    public int? Dy { get; set; }
    public int? Delta { get; set; }
    public string? Button { get; set; }
    public string? Text { get; set; }
    public string? Key { get; set; }
    public string[]? Keys { get; set; }
    public bool? Down { get; set; }
    public bool? Enabled { get; set; }
}

static class Metrics
{
    public static object Read()
    {
        var x = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var y = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var width = NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN);
        var height = NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN);
        return new { x, y, width, height };
    }
}

static class InputApplier
{
    public static void Apply(InputCommand command)
    {
        switch (command.Type)
        {
            case "mouseMove":
                MouseMove(command.Dx ?? 0, command.Dy ?? 0);
                return;
            case "mouseAbs":
                MouseAbsolute(command.X ?? 0, command.Y ?? 0);
                return;
            case "mouseButton":
                MouseButton(command.Button ?? "left", command.Down ?? false);
                return;
            case "click":
                Click(command.Button ?? "left");
                return;
            case "doubleClick":
                Click(command.Button ?? "left");
                Thread.Sleep(45);
                Click(command.Button ?? "left");
                return;
            case "wheel":
                Wheel(command.Delta ?? 0);
                return;
            case "key":
                Key(command.Key ?? "", command.Down ?? false);
                return;
            case "shortcut":
                Shortcut(command.Keys ?? Array.Empty<string>());
                return;
            case "text":
                Text(command.Text ?? "");
                return;
            default:
                throw new InvalidOperationException($"Unsupported command type '{command.Type}'.");
        }
    }

    static void MouseMove(int dx, int dy)
    {
        Send(new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            U = new NativeMethods.InputUnion
            {
                mi = new NativeMethods.MOUSEINPUT
                {
                    dx = dx,
                    dy = dy,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE
                }
            }
        });
    }

    static void MouseAbsolute(int x, int y)
    {
        var vx = NativeMethods.GetSystemMetrics(NativeMethods.SM_XVIRTUALSCREEN);
        var vy = NativeMethods.GetSystemMetrics(NativeMethods.SM_YVIRTUALSCREEN);
        var vw = Math.Max(1, NativeMethods.GetSystemMetrics(NativeMethods.SM_CXVIRTUALSCREEN));
        var vh = Math.Max(1, NativeMethods.GetSystemMetrics(NativeMethods.SM_CYVIRTUALSCREEN));
        var normalizedX = (int)Math.Round(((x - vx) * 65535.0) / Math.Max(1, vw - 1));
        var normalizedY = (int)Math.Round(((y - vy) * 65535.0) / Math.Max(1, vh - 1));

        Send(new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            U = new NativeMethods.InputUnion
            {
                mi = new NativeMethods.MOUSEINPUT
                {
                    dx = normalizedX,
                    dy = normalizedY,
                    dwFlags = NativeMethods.MOUSEEVENTF_MOVE | NativeMethods.MOUSEEVENTF_ABSOLUTE | NativeMethods.MOUSEEVENTF_VIRTUALDESK
                }
            }
        });
    }

    static void MouseButton(string button, bool down)
    {
        uint flag = button.ToLowerInvariant() switch
        {
            "right" => down ? NativeMethods.MOUSEEVENTF_RIGHTDOWN : NativeMethods.MOUSEEVENTF_RIGHTUP,
            "middle" => down ? NativeMethods.MOUSEEVENTF_MIDDLEDOWN : NativeMethods.MOUSEEVENTF_MIDDLEUP,
            _ => down ? NativeMethods.MOUSEEVENTF_LEFTDOWN : NativeMethods.MOUSEEVENTF_LEFTUP
        };

        Send(new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            U = new NativeMethods.InputUnion { mi = new NativeMethods.MOUSEINPUT { dwFlags = flag } }
        });
    }

    static void Click(string button)
    {
        MouseButton(button, true);
        Thread.Sleep(20);
        MouseButton(button, false);
    }

    static void Wheel(int delta)
    {
        Send(new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_MOUSE,
            U = new NativeMethods.InputUnion
            {
                mi = new NativeMethods.MOUSEINPUT
                {
                    mouseData = delta,
                    dwFlags = NativeMethods.MOUSEEVENTF_WHEEL
                }
            }
        });
    }

    static void Key(string key, bool down)
    {
        var vk = KeyMap.VirtualKey(key);
        Send(new NativeMethods.INPUT
        {
            type = NativeMethods.INPUT_KEYBOARD,
            U = new NativeMethods.InputUnion
            {
                ki = new NativeMethods.KEYBDINPUT
                {
                    wVk = vk,
                    dwFlags = down ? 0u : NativeMethods.KEYEVENTF_KEYUP
                }
            }
        });
    }

    static void Shortcut(string[] keys)
    {
        foreach (var key in keys)
        {
            Key(key, true);
            Thread.Sleep(8);
        }

        for (var i = keys.Length - 1; i >= 0; i--)
        {
            Key(keys[i], false);
            Thread.Sleep(8);
        }
    }

    static void Text(string text)
    {
        foreach (var ch in text)
        {
            Send(new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_KEYBOARD,
                U = new NativeMethods.InputUnion
                {
                    ki = new NativeMethods.KEYBDINPUT
                    {
                        wScan = ch,
                        dwFlags = NativeMethods.KEYEVENTF_UNICODE
                    }
                }
            });
            Send(new NativeMethods.INPUT
            {
                type = NativeMethods.INPUT_KEYBOARD,
                U = new NativeMethods.InputUnion
                {
                    ki = new NativeMethods.KEYBDINPUT
                    {
                        wScan = ch,
                        dwFlags = NativeMethods.KEYEVENTF_UNICODE | NativeMethods.KEYEVENTF_KEYUP
                    }
                }
            });
        }
    }

    static void Send(NativeMethods.INPUT input)
    {
        var inputs = new[] { input };
        var sent = NativeMethods.SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<NativeMethods.INPUT>());
        if (sent != inputs.Length)
        {
            throw new InvalidOperationException($"SendInput sent {sent}/{inputs.Length} events.");
        }
    }
}

static class KeyMap
{
    public static ushort VirtualKey(string key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new InvalidOperationException("Key is required.");
        }

        var normalized = key.Trim().ToLowerInvariant();
        return normalized switch
        {
            "ctrl" or "control" => 0x11,
            "alt" => 0x12,
            "shift" => 0x10,
            "win" or "meta" or "cmd" or "command" => 0x5B,
            "escape" or "esc" => 0x1B,
            "enter" or "return" => 0x0D,
            "tab" => 0x09,
            "backspace" => 0x08,
            "delete" or "del" => 0x2E,
            "space" => 0x20,
            "arrowup" or "up" => 0x26,
            "arrowdown" or "down" => 0x28,
            "arrowleft" or "left" => 0x25,
            "arrowright" or "right" => 0x27,
            "home" => 0x24,
            "end" => 0x23,
            "pageup" => 0x21,
            "pagedown" => 0x22,
            "f1" => 0x70,
            "f2" => 0x71,
            "f3" => 0x72,
            "f4" => 0x73,
            "f5" => 0x74,
            "f6" => 0x75,
            "f7" => 0x76,
            "f8" => 0x77,
            "f9" => 0x78,
            "f10" => 0x79,
            "f11" => 0x7A,
            "f12" => 0x7B,
            _ when normalized.Length == 1 && char.IsLetterOrDigit(normalized[0]) => char.ToUpperInvariant(normalized[0]),
            _ => throw new InvalidOperationException($"Unsupported key '{key}'.")
        };
    }
}

static class NativeMethods
{
    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;

    public const int SM_XVIRTUALSCREEN = 76;
    public const int SM_YVIRTUALSCREEN = 77;
    public const int SM_CXVIRTUALSCREEN = 78;
    public const int SM_CYVIRTUALSCREEN = 79;

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;

    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int nIndex);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public int type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct InputUnion
    {
        [FieldOffset(0)]
        public MOUSEINPUT mi;

        [FieldOffset(0)]
        public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
}
