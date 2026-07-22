; Neato Rewind NSIS installer hooks.
;
; Kill the running app AND its Python sidecar before the installer copies
; files. Without this, updating over a running install fails with
;   "Error opening file for writing: ...\neato-rewind-backend.exe"
; because the sidecar (a PyInstaller parent+child pair spawned by the app)
; holds the exe open. Tauri's built-in running-app check covers the main
; window process but NOT the sidecar, so we terminate it explicitly here.
; /F = force, /T = whole process tree (catches the PyInstaller child).

!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Closing Neato Rewind (and its backend) before updating..."
  nsExec::Exec 'taskkill /F /T /IM neato-rewind-backend.exe'
  nsExec::Exec 'taskkill /F /T /IM neato-rewind.exe'
  ; brief pause so Windows releases the file handles before we copy over them
  Sleep 1500
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::Exec 'taskkill /F /T /IM neato-rewind-backend.exe'
  nsExec::Exec 'taskkill /F /T /IM neato-rewind.exe'
  Sleep 1000
!macroend
