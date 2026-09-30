# Hýsa Partner Referrals – opsætningsguide

Koden ligger på GitHub. Hver gang der ændres noget, lægger GitHub det automatisk ud på Cloudflare (gratis), som kører siderne og databasen. GitHub kører også et job hver time, som henter onlineordrer, sender mails og laver fakturaer.

Følg trinene i rækkefølge. Hvert trin slutter med et tjek, så du ved, at det virker, før du går videre.

---

## Trin 1 – Læg koden på GitHub (10 min)

1. Åbn repoet **Hysaproperties/H-sa-Partners-Data**.
2. Slet de gamle filer fra første version: klik på hver fil → skraldespandsikonet → **Commit changes**. Behold kun `README.md`.
3. Pak `hysa-partners-v2.zip` ud på din computer.
4. I repoet: **Add file → Upload files**. Træk **alt indholdet** af den udpakkede mappe ind (ikke selve mappen). Klik **Commit changes**.
5. Mappen `.github` er skjult på nogle computere. Tjek i repoet, at mappen `.github/workflows` findes med `deploy.yml` og `jobs.yml`. Hvis den mangler: **Add file → Create new file**, skriv `.github/workflows/deploy.yml` som navn, indsæt indholdet fra filen og commit. Gør det samme med `jobs.yml`.

**Tjek:** Repoet viser mapperne `public`, `worker`, `scripts`, `.github` og filerne `wrangler.toml` og `schema.sql`.

## Trin 2 – Opret Cloudflare (10 min)

1. Gå til **dash.cloudflare.com** og opret en gratis konto med hysa@hysa.fo.
2. Klik i menuen på **Workers & Pages**. Første gang bliver du bedt om at vælge et subdomæne (fx `hysa`). Vælg det og bekræft.
3. Find dit **Account ID**. Det står på forsiden af Workers & Pages i højre side. Kopiér det.
4. Lav en API-nøgle: klik på profilikonet øverst til højre → **My Profile → API Tokens → Create Token**.
   - Vælg skabelonen **Edit Cloudflare Workers** → **Use template**.
   - Under *Permissions* klikker du **+ Add more** og tilføjer: **Account → D1 → Edit**.
   - Under *Account Resources* vælger du din konto. Under *Zone Resources* vælger du **All zones**.
   - **Continue to summary → Create Token**. Kopiér nøglen (den vises kun én gang).

**Tjek:** Du har to ting kopieret: Account ID og API Token.

## Trin 3 – Læg hemmeligheder ind på GitHub (10 min)

I repoet: **Settings → Secrets and variables → Actions → New repository secret**. Opret disse, én ad gangen:

| Name | Værdi |
|---|---|
| `CLOUDFLARE_API_TOKEN` | API-nøglen fra trin 2 |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID fra trin 2 |
| `ADMIN_PASSWORD` | `Sourcemenu4` |
| `JOB_KEY` | En lang tilfældig tekst, fx 30 tilfældige bogstaver og tal. Den skal ingen huske |
| `SMTP_HOST` | Udgående mailserver for hysa@hysa.fo (se tabellen nedenfor) |
| `SMTP_PORT` | Se tabellen nedenfor |
| `SMTP_USER` | `hysa@hysa.fo` |
| `SMTP_PASS` | Adgangskode til hysa@hysa.fo (for Google/Microsoft: en app-adgangskode) |

| Hvis hysa@hysa.fo ligger hos | SMTP_HOST | SMTP_PORT | SMTP_PASS |
|---|---|---|---|
| Google Workspace (Gmail) | `smtp.gmail.com` | `465` | App-adgangskode: myaccount.google.com → Security → 2-Step Verification → App passwords |
| Microsoft 365 (Outlook) | `smtp.office365.com` | `587` | App-adgangskode eller almindelig kode. "Authenticated SMTP" skal være slået til for postkassen i Microsoft 365 admin |
| Andet (fx one.com, Simply, Vevhotel) | Står i udbyderens vejledning for "SMTP" eller "udgående server" | Normalt `465` | Postkassens adgangskode |

**Tjek:** Der står 8 secrets på listen.

## Trin 4 – Sæt det hele i luften (5 min)

1. I repoet: fanen **Actions**. Ser du en knap "I understand my workflows, go ahead and enable them", så klik på den.
2. Vælg **Deploy to Cloudflare** i venstre side → **Run workflow** → **Run workflow**.
3. Vent 1–2 minutter, til den får et grønt flueben.
4. Klik ind på kørslen → **deploy** → trinnet **Deploy**. Her står jeres adresse, fx `https://hysa-partners.hysa.workers.dev`. Gem den.
5. Vælg **Hourly orders, emails and invoices** → **Run workflow**. Vent på det grønne flueben.

**Tjek:** Åbn adressen. Gæsteguiden vises (tom indtil videre). Åbn `adressen/admin.html` og log ind med `Sourcemenu4`.

Bliver en kørsel rød, så klik på den og send mig et billede af fejlen.

## Trin 5 – Tjek indstillingerne (2 min)

Admin → **Settings**. Firma, adresse, bank, IBAN, 25% VAT, 8 dages betaling og standardprovision (10%) er udfyldt. Tilføj V-tal, ret det, der er forkert, og klik **Save settings**.

## Trin 6 – Test med en falsk leverandør (10 min)

1. Åbn `adressen/join.html` og tilmeld "Test Café" med din egen mail og hjemmeside `example.com`. Vælg **In person only**.
2. Inden for en time får du en mail om en ny tilmelding. Du kan også trykke **Run workflow** på det timelige job for at gøre det med det samme.
3. Admin → **Partners** → Test Café → **Approve**.
4. Kør det timelige job igen. Du får velkomstmailen med partnersidens link.
5. Åbn partnersiden fra mailen → registrér et køb på 100 kr.
6. Kør jobbet igen. Du får mailen om salget.
7. Admin → **Sales**: salget står der med 10 kr. i provision.
8. Slet Test Café og salget i admin, når du er færdig.

**Tjek:** Du har fået 3 mails fra hysa@hysa.fo. Så kører alt.

---

## Sådan kobler I en leverandør på (hver gang)

Send dem én mail med tilmeldingslinket. De klarer resten selv:

> **Subject:** Get recommended to Hýsa guests
>
> Hi [name],
>
> We host guests in holiday apartments across the Faroe Islands and would like to recommend [business] in our guest guide. You only pay a commission on what our guests actually buy, invoiced once a month.
>
> Sign up here (5 minutes): **[adressen]/join.html**
>
> Kind regards,
> Hýsa Sp/f

Derefter sker følgende:

| | Hvem | Hvad |
|---|---|---|
| 1 | Leverandør | Udfylder tilmeldingen og vælger, hvordan gæster booker hos dem |
| 2 | System | Du får en mail: "New partner sign-up" |
| 3 | Dig | Admin → Partners → åbn → ret evt. provisionen → **Approve** |
| 4 | System | Leverandøren får en velkomstmail med sin partnerside og kommer i gæsteguiden |
| 5 | Leverandør | **Shopify/WooCommerce:** har allerede indsat nøglen ved tilmelding, så de skal intet gøre. **Anden hjemmeside:** giver koden fra partnersiden til sin webmand. **Kun fysisk salg:** registrerer køb på partnersiden |

## Hvordan salg bliver fanget

| Hvordan gæsten køber | Hvordan det registreres | Automatisk? |
|---|---|---|
| Online, Shopify eller WooCommerce | Gæsten klikker på "Visit & book" i guiden. Shoppen husker det usynlige Hýsa-mærke på ordren, og jobbet henter ordren hver time | Ja |
| Online, anden hjemmeside eller bookingsystem | Tracking-koden på deres side melder ordren, når gæsten er kommet via linket | Ja, når koden er sat ind |
| Med rabatkode (Shopify/WooCommerce) | Ordrer med koden tælles, også uden klik | Ja |
| Fysisk i butik/restaurant | Leverandøren registrerer købet på sin partnerside, og/eller gæsten sender en kvittering på `adressen/receipt.html` | Registreres af dem. Matcher de to på dato og beløb, bindes de automatisk sammen |
| Kun gæstens kvittering, ingen melding fra leverandøren | Lander i admin som **Needs approval** med foto af kvitteringen | Du godkender |

## Hvad der sker automatisk hver time

- Nye onlineordrer hentes fra tilsluttede shops.
- Leverandøren får en mail om hvert nyt salg, og I får en kopi.
- I får en mail om nye tilmeldinger og nye gæstekvitteringer.
- Godkendte leverandører får velkomstmail.
- **Den 1. i måneden** laves en PDF-faktura pr. leverandør for sidste måned (25% VAT, 8 dage) og sendes fra hysa@hysa.fo til deres fakturamail.

## Adresser

| Side | Til | Adresse |
|---|---|---|
| Gæsteguide | Alle gæster (i velkomstbeskeden) | `adressen/` |
| Kvittering | Gæster, der køber fysisk | `adressen/receipt.html` |
| Tilmelding | Nye leverandører | `adressen/join.html` |
| Partnerside | Hver leverandør (privat link i velkomstmailen) | `adressen/partner.html#…` |
| Admin | Jer, kode Sourcemenu4 | `adressen/admin.html` |

Eget domæne (fx `partners.hysa.fo`) kan sættes på senere under Workers & Pages → hysa-partners → Settings → Domains, hvis hysa.fo flyttes til Cloudflare.

Skift af admin-kode: ret secret `ADMIN_PASSWORD` på GitHub og kør **Deploy to Cloudflare** igen.
