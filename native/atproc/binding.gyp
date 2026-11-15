{
  "targets": [
    {
      "target_name": "atproc",
      "sources": ["atproc.c"],
      "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE"],
      "libraries": ["ntdll.lib", "kernel32.lib", "powrprof.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": { "WarningLevel": 3 },
        "VCLinkerTool": { "AdditionalOptions": ["/PDBALTPATH:%_PDB%"] }
      }
    }
  ]
}
