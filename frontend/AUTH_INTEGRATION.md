# Shared Authentication and Provider Integration

## Authentication and routing

The app uses the shared RoleSelectionScreen and LoginScreen with a single AuthContext listener and the existing Firebase login/logout service. Restored sessions load and validate `users/{uid}.role` before protected routes mount. A provider account opens ProviderDashboard through ProviderHome; logout returns to shared authentication. There is one top-level NavigationContainer.

Provider web routes remain nested under the authenticated ProviderFlow. The old `/provider-entry` path resolves to shared role selection when signed out. WarrantyProviderEntryScreen remains in source for compatibility but is not registered in the normal authentication flow.

## Provider behavior and data

Create Warranty Request is a dashboard Quick Action beside View All Requests and Notifications. Existing Firestore request/appliance/warranty reads and writes, document confirmations, verification decisions, notifications, status updates, and finalized read-only behavior remain in place. Document review records manual confirmations only; it does not upload files.

The authenticated UID is passed separately from the optional query filter. New warranty and warranty-request records use the UID as `providerId`; existing queries keep their prior scope, so legacy records are not hidden, migrated, overwritten, or deleted. Firestore rules remain the authority for access. Profile uses shared account details and the shared logout function.

## Manual verification

1. Start the frontend with `npx expo start --clear`; press `w` for web or open Expo Go.
2. Confirm signed-out startup shows shared role selection, with no create-request action. Select Warranty Provider and log in with a matching Firebase account; invalid credentials and role mismatches must not open provider routes.
3. Verify the dashboard counts and Quick Actions. Create a valid request and confirm the linked appliance, warranty, and request records in Firestore; warranty/request `providerId` values should match the signed-in UID.
4. Open the request, edit supported customer/appliance fields, confirm all three document-review items, and continue through warranty verification and status update. Reload and verify persisted values and notification creation.
5. Open Notifications, mark one and all as read, and use View Request. Approved/rejected requests must open finalized read-only details; pending/more-information requests may continue the workflow.
6. Check Profile identity and log out. Confirm shared authentication returns and browser back or direct provider URLs do not expose provider screens while signed out.
7. Log in again and reload to test session restoration. On web, refresh provider routes and use browser back/forward; repeat navigation on Android/iOS.

Automated tests use mocked Firebase services. They do not establish live authentication or Firestore success; those require the manual checks above with a real account. Customer IDs remain request-scoped until a shared customer identity is integrated.
