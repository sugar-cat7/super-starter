# Windows process ownership: create atomically inside a kill-on-close Job,
# then resume. Descendants remain in the Job even after intermediate parents exit.
$ErrorActionPreference = 'Stop'
$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:STARTER_PROCESS_SPEC)) | ConvertFrom-Json
[Environment]::SetEnvironmentVariable('STARTER_PROCESS_SPEC', $null)
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StarterJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
    public uint cb;
    public string lpReserved, lpDesktop, lpTitle;
    public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public ushort wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupEx {
    public Startup StartupInfo;
    public IntPtr AttributeList;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr hProcess, hThread;
    public uint dwProcessId, dwThreadId;
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimit limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string application, System.Text.StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  static void Check(bool success) { if (!success) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  public static int Run(string command) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    Check(job != IntPtr.Zero);
    ProcessInfo process = new ProcessInfo();
    IntPtr attributes = IntPtr.Zero, jobList = IntPtr.Zero;
    bool initialized = false;
    try {
      ExtendedLimit limits = new ExtendedLimit();
      limits.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      Check(size != IntPtr.Zero);
      attributes = Marshal.AllocHGlobal(size);
      Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref size));
      initialized = true;
      jobList = Marshal.AllocHGlobal(IntPtr.Size);
      Marshal.WriteIntPtr(jobList, job);
      // PROC_THREAD_ATTRIBUTE_JOB_LIST: membership is atomic with creation.
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x2000D), jobList, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      StartupEx startup = new StartupEx();
      startup.StartupInfo.cb = (uint)Marshal.SizeOf(typeof(StartupEx));
      startup.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
      startup.StartupInfo.hStdInput = GetStdHandle(-10);
      startup.StartupInfo.hStdOutput = GetStdHandle(-11);
      startup.StartupInfo.hStdError = GetStdHandle(-12);
      startup.AttributeList = attributes;
      Check(CreateProcessW(null, new System.Text.StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x80004, IntPtr.Zero, null, ref startup, out process));
      Check(ResumeThread(process.hThread) != 0xffffffff);
      Check(WaitForSingleObject(process.hProcess, 0xffffffff) == 0);
      uint code;
      Check(GetExitCodeProcess(process.hProcess, out code));
      return unchecked((int)code);
    } finally {
      // All created children already belong to the Job, including before resume.
      if (process.hProcess != IntPtr.Zero) TerminateProcess(process.hProcess, 1);
      CloseHandle(job);
      if (initialized) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
    }
  }
}
'@
exit ([StarterJob]::Run($spec.commandLine))
