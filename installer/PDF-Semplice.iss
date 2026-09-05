#define MyAppName "PDF Semplice"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "Taverna Software"
#define MyAppExeName "PDF Semplice.exe"

[Setup]
AppId={{B8C6FA7A-44A4-4CC7-9093-5E688B63EAE4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\PDF Semplice
DefaultGroupName=PDF Semplice
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=PDF-Semplice-Setup-1.0.0
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}
PrivilegesRequired=lowest

[Files]
Source: "..\artifacts\publish\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\PDF Semplice"; Filename: "{app}\{#MyAppExeName}"
Name: "{userdesktop}\PDF Semplice"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Crea un collegamento sul desktop"; GroupDescription: "Collegamenti:"; Flags: unchecked

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Avvia PDF Semplice"; Flags: nowait postinstall skipifsilent
