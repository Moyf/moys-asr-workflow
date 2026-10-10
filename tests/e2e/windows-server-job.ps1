# An unnamed, non-inheritable Job handle belongs only to this supervisor.
# Join before spawning: even a wrapper that exits immediately cannot orphan its
# children. Closing this process (or its stdin owner) closes the Job handle.
param([string]$EncodedCommand)
$ErrorActionPreference = 'Stop'
try {
    $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($EncodedCommand)) | ConvertFrom-Json
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

public static class MawServerJob {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessUserTime, PerJobUserTime;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters {
        public ulong ReadOperations, WriteOperations, OtherOperations;
        public ulong ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // Windows CommandLineToArgvW/CRT quoting, without a command shell.
    static string Quote(string value) {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            text.Append('\\', slashes * (c == '"' ? 2 : 1));
            if (c == '"') text.Append('\\');
            text.Append(c);
            slashes = 0;
        }
        text.Append('\\', slashes * 2);
        return text.Append('"').ToString();
    }

    public static void Run(string command, string[] arguments) {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)) ||
            !AssignProcessToJobObject(job, Process.GetCurrentProcess().Handle)) {
            int error = Marshal.GetLastWin32Error();
            CloseHandle(job);
            throw new Win32Exception(error);
        }
        // The owner retains stdin exclusively; the actual server gets EOF.
        // Owner death also closes this pipe, even without a JS exit hook.
        Task.Run(() => { Console.OpenStandardInput().CopyTo(System.IO.Stream.Null); Environment.Exit(125); });
        var args = new StringBuilder();
        foreach (string argument in arguments) args.Append(Quote(argument)).Append(' ');
        var info = new ProcessStartInfo(command, args.ToString());
        info.UseShellExecute = false;
        info.RedirectStandardInput = true;
        using (var child = Process.Start(info)) {
            child.StandardInput.Close();
            child.WaitForExit();
            // Exit closes our sole job handle, including surviving descendants.
            Environment.Exit(child.ExitCode);
        }
    }
}
'@
    [MawServerJob]::Run([string]$spec.command, [string[]]$spec.args)
} catch {
    [Console]::Error.WriteLine($_.Exception.ToString())
    exit 1
}
