; Inno Setup definition for the recommended per-user MAW Windows package.
; The build script supplies MAW_VERSION and MAW_SOURCE_DIR with /D defines.

#define AppVersion GetEnv("MAW_VERSION")
#if AppVersion == ""
  #define AppVersion "0.0.0"
#endif
#define MawSourceDir GetEnv("MAW_SOURCE_DIR")
#if MawSourceDir == ""
  #define MawSourceDir AddBackslash(SourcePath) + "..\\dist\\MAW"
#endif

[Setup]
AppId={{4E6B4A8C-0E4F-4E88-8C9F-1DF1C9BFB0F7}
AppName=Moy's ASR Workflow
AppVersion={#AppVersion}
AppPublisher=Moyf
AppPublisherURL=https://github.com/Moyf/moys-asr-workflow
AppSupportURL=https://github.com/Moyf/moys-asr-workflow/issues
AppUpdatesURL=https://github.com/Moyf/moys-asr-workflow/releases
DefaultDirName={localappdata}\Programs\MAW
UsePreviousAppDir=yes
DefaultGroupName=Moy's ASR Workflow
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=.
OutputBaseFilename=MAW-Setup-Windows-x64-v{#AppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile={#MawSourceDir}\assets\maw.ico
UninstallDisplayIcon={app}\assets\maw.ico
UninstallDisplayName=Moy's ASR Workflow
CloseApplications=yes
RestartApplications=yes
ChangesAssociations=no
PrivilegesRequiredOverridesAllowed=commandline

[Files]
Source: "{#MawSourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{autoprograms}\Moy's ASR Workflow"; Filename: "{app}\MAW.exe"; WorkingDir: "{app}"

[Registry]
Root: HKCU; Subkey: "Software\Moy\MAW"; ValueType: string; ValueName: "InstallPath"; ValueData: "{app}"; Flags: uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Moy\MAW"; ValueType: string; ValueName: "ExecutablePath"; ValueData: "{app}\MAW.exe"; Flags: uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Moy\MAW"; ValueType: string; ValueName: "InstallKind"; ValueData: "installer"; Flags: uninsdeletekeyifempty
Root: HKCU; Subkey: "Software\Moy\MAW"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"; Flags: uninsdeletekeyifempty

[Code]
function InitializeSetup(): Boolean;
begin
  Result := FileExists(ExpandConstant('{#MawSourceDir}\MAW.exe')) and
    FileExists(ExpandConstant('{#MawSourceDir}\ffmpeg\bin\ffmpeg.exe')) and
    FileExists(ExpandConstant('{#MawSourceDir}\ffmpeg\bin\ffprobe.exe'));
  if not Result then
    MsgBox('The MAW standard bundle or its bundled FFmpeg files are missing.', mbError, MB_OK);
end;
