# Acme Shop (Expo / React Native)

- Bundle: `com.acme.shop` (iOS and Android). Web: none.
- Login: **always** via auth bypass (`acme://e2e/auth?token=…`, injected by Revlee). Never type passwords or tap "Sign in with Google".
- Key screens: Home (tab 1), Products (tab 2), Product (details), Cart (tab 3, badge with counter `testID=cart-badge`), Profile (tab 4).
- The onboarding modal may appear once after installation: close it with the "Skip" button.
- State reset: `acme://e2e/reset` (clears the cart and cache).
- Do not touch: Checkout → "Pay" (payment), Profile → "Delete account".
- Test data: the products "Orchid Mantis" (62 PLN) and "Gold Tortoise" (18 PLN) always exist on api-test.
- Known flakes: the promo banner on Home loads 1–2 s after launch; do not wait for it.
