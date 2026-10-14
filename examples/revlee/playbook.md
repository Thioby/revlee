# Acme Shop (Expo / React Native)

- Bundle: `com.acme.shop` (iOS i Android). Web: brak.
- Logowanie: **zawsze** przez auth bypass (`acme://e2e/auth?token=…`, wstrzykiwany przez Revlee). Nigdy nie wpisuj haseł ani nie klikaj „Zaloguj przez Google”.
- Ekrany kluczowe: Home (tab 1), Products (tab 2), Product (szczegóły), Cart (tab 3, badge z licznikiem `testID=cart-badge`), Profile (tab 4).
- Onboarding modal może pojawić się raz po instalacji: zamknij przyciskiem „Pomiń”.
- Reset stanu: `acme://e2e/reset` (czyści koszyk i cache).
- Nie dotykaj: Checkout → „Zapłać” (płatność), Profile → „Usuń konto”.
- Dane testowe: produkt „Orchid Mantis” (62 zł) i „Gold Tortoise” (18 zł) zawsze istnieją na api-test.
- Znane flaki: baner promocyjny na Home ładuje się 1–2 s po starcie; nie czekaj na niego.
