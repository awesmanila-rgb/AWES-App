# AWES Android App

Native Android application module for the existing **AWES Service Report Form** repository.

This module is intentionally kept under `android/` so the existing web/PWA application remains untouched.

See `ANDROID_SETUP.md` for GitHub upload and Android Studio setup instructions.


## Target platform split

This Android project is the **technician application**. The existing repository's web/PWA application is intended to become the **admin-only browser application**. Both should use the same backend, with server-side role authorization enforcing the separation.
