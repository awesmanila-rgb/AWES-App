# AWES Application Architecture

## Platform separation

The target architecture is:

- **Administrator:** browser/web application only.
- **Technician:** native Android application.
- Both platforms use the same backend and authorization system.

```text
                    AWES BACKEND
                         |
              +----------+----------+
              |                     |
           ADMIN                TECHNICIAN
              |                     |
        Browser / Web          Android App
              |                     |
        Admin features       Field features
```

## Security requirement

The separation must be enforced by the backend, not only by hiding UI routes.

Every authenticated request must be authorized by role:

- `admin` -> browser/admin features
- `technician` -> Android/technician features

A technician who manually opens an admin URL must still be denied by the backend.

## Existing web application

The existing PWA/web application should be retained as the administrator interface while the Android application is developed. Do not remove the existing web files.

## Android application

The Android project in this folder is the technician-side foundation. It is intended for:

- Service Reports
- DTR
- Leave
- Cash Advance
- Technician-specific account/session functions

The final production version should connect these modules to the shared backend.
