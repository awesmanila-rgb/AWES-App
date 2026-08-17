# AWES Android module

This folder is designed to be uploaded as `android/` inside the existing `AWES-Service-Report-Form` GitHub repository.

## Repository layout

```text
AWES-Service-Report-Form/
├── service_report_app.html
├── index.html
├── manifest.json
├── sw.js
└── android/
    ├── app/
    ├── build.gradle.kts
    ├── settings.gradle.kts
    └── gradle.properties
```

## Open in Android Studio

1. Upload/commit this whole `android/` folder to GitHub.
2. Clone/pull the repository on your computer.
3. In Android Studio choose **Open** and select the `android/` folder.
4. Allow Android Studio to install/sync the Android Gradle Plugin and dependencies.
5. Run the `app` configuration on an Android device or emulator.

## Current architecture

- Kotlin
- Jetpack Compose
- Material 3
- Android Navigation Compose
- ViewModel + repository boundary
- Offline local repository for the first development stage
- Password hashing with per-user salt
- Location permission and GPS capture for DTR
- Device-lock boundary for technician DTR

## Important security note

The local repository seeds a temporary development admin credential hash from `CHANGE-ME`. Change the admin credential before production deployment. Do not place production passwords, PINs, service keys, or Supabase/Firebase secrets in this source tree.

## Backend boundary

Feature screens call `AppViewModel`, which calls `AppRepository`. A production Supabase/Firebase implementation can replace `LocalRepository` without rewriting the UI screens.

## Production work still required

1. Connect the repository to the production authentication/database backend.
2. Implement durable serialization/storage for service reports, DTR, leave and cash-advance records.
3. Complete the Service Report editor field-for-field from the existing web application.
4. Implement customer/technician signature capture and PDF rendering.
5. Implement admin approval/restriction workflows and backend authorization rules.
6. Test on the actual Android devices used by technicians.
