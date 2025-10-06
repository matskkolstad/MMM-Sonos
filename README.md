# MMM-Sonos

En MagicMirror²-modul som automatisk finner Sonos-sonene dine og viser hva som spilles – inkludert tittel, artist, album og hvilke høyttalere som er med i gruppen. Modulen er laget for å se bra ut på både små og store skjermer, og gir deg full kontroll på hva som skal vises.

**Utviklet av:** Mats Kjoshagen Kolstad

## Høydepunkter

- 🔍 Automatisk Sonos-discovery – ingen manuell IP-konfigurasjon.
- 🎵 Viser gjeldende spor med tittel, artist, album og albumbilde.
- 🧩 Viser grupper som én enhet (ingen dobbeltvisning av høyttalere i samme gruppe).
- 🙈 Skjul enkelt bestemte høyttalere eller grupper i konfigurasjonen.
- 🧱 Fleksibel layout: rad, rutenett eller automatisk fordeling basert på antall grupper.
- 🔠 Juster tekststørrelse, albumbilde-størrelse, maksantall grupper og bredde direkte i config.
- 🧭 Juster plassering/justering uten ekstra CSS – velg mellom venstre, senter, høyre eller jevn fordeling.
- 🕒 Vis siste oppdateringstid og (valgfritt) skjul modulen når ingenting spiller.

## Ansvarsfraskrivelse

Denne modulen er utviklet ved hjelp av AI-assistanse og ble laget primært for mitt eget bruk. Repoet deles i håp om at andre kan ha glede av det, men jeg kan ikke love videre vedlikehold eller oppdateringer. Brukere er selv ansvarlige for å holde modulen oppdatert, tilpasse den etter egne behov og følge med på endringer som kan påvirke funksjonaliteten.

## Kom i gang

1. Gå til MagicMirror sin `modules`-mappe og klon (eller kopier) katalogen:

   ```pwsh
   cd ~/MagicMirror/modules
   git clone https://github.com/<ditt-repo>/MMM-Sonos.git
   ```

   > **Tips:** Ligger modulen allerede på maskinen (som i denne oppgaven) kan du kopiere mappen direkte inn i `modules`-katalogen.

2. Installer avhengigheter:

   ```pwsh
   cd MMM-Sonos
   npm install
   ```

3. Legg til modulen i `config/config.js`:

   ```javascript
   {
     module: 'MMM-Sonos',
       position: 'bottom_left',
     config: {
            updateInterval: 15000,
            displayMode: 'row',
            columns: 2,
            albumArtSize: 80,
            fontScale: 1,
            hiddenSpeakers: ['Bad'],
            hiddenGroups: ['Terrasse'],
            knownDevices: ['192.168.68.55', '192.168.68.63', '192.168.68.75'],
            showAlbum: false,
            showGroupMembers: true,
            hideWhenNothingPlaying: true,
            showWhenPaused: false,
            showPlaybackState: false,
                  showLastUpdated: false,
                  cardMinWidth: 150
     }
   }
   ```

4. Start (eller restart) MagicMirror². Modulen dukker opp etter at første Sonos-gruppe er funnet.

## Konfigurasjon

| Nøkkel | Standard | Beskrivelse |
| --- | --- | --- |
| `updateInterval` | `15000` | Hvor ofte (i ms) modulen spør Sonos om ny status. Minimum 5000 ms anbefales. |
| `discoveryTimeout` | `5000` | Tid (ms) som brukes på å finne første Sonos-enhet. Øk dersom nettverket er tregt. |
| `hiddenSpeakers` | `[]` | Liste med romnavn/høyttalere som aldri skal vises. Hvis en gruppe inneholder en skjult høyttaler, skjules hele gruppen. |
| `hiddenGroups` | `[]` | Skjul grupper ved navn eller ID. |
| `knownDevices` | `[]` | Liste med statiske IP-adresser til Sonos-enheter dersom automatisk søk ikke fungerer. |
| `maxGroups` | `6` | Maks antall grupper som rendres. Praktisk ved mange soner. |
| `displayMode` | `'row'` | `auto`, `grid` eller `row`. `row` viser alle grupper på én linje med horisontal scrolling ved behov. `grid` arrangerer kort i `columns` kolonner. `auto` bytter til grid når antall grupper overstiger `columns`. |
| `columns` | `2` | Antall kolonner i grid-modus (mellom 1 og 4). Brukes også som terskel for når `auto` går over til grid. |
| `fontScale` | `1` | Multiplier for tekststørrelse. 1.2 gir 20 % større tekst. |
| `albumArtSize` | `80` | Størrelse på albumbilde i piksler. |
| `wrapText` | `true` | Tillat linjebryting. Sett til `false` for én linje med ellipsis. |
| `maxTextLines` | `2` | Maks antall linjer for tittelen (gjelder kun når `wrapText` er `true`). |
| `textAlignment` | `'center'` | Venstre (`left`), senter (`center`) eller høyre (`right`) tekstjustering. |
| `justifyContent` | `'center'` | Horisontal fordeling av kort: `flex-start`, `center`, `space-between`, etc. |
| `moduleWidth` | `null` | Sett bredde på modul (f.eks. `"600px"`, `"80%"`). |
| `forceHttps` | `false` | Tving albumbilder over HTTPS (bruk hvis du har reverse proxy med HTTPS). |
| `hideWhenNothingPlaying` | `true` | Skjul modulen når ingenting spiller. Viser ellers en rolig "Ingen høyttalere spiller"-tekst. |
| `showWhenPaused` | `false` | Vis gruppen selv om den er pauset. |
| `fadePausedGroups` | `true` | Ton ned grupper som ikke spiller aktivt. |
| `showGroupMembers` | `true` | Vis hvilke rom som er med i gruppen (kun når det er mer enn én). |
| `showPlaybackState` | `false` | Vis status-etikett (Spiller, Pauset, osv.). |
| `showLastUpdated` | `false` | Viser en liten tidsstempel for når data sist ble oppdatert. |
| `timeFormat24` | `true` | Bruk 24-timersklokke i tidsstempelet. |
| `dateLocale` | `'nb-NO'` | Språk/locale for tidsstempelet. |
| `accentuateActive` | `true` | Gir en tydelig bakgrunn på grupper som spiller. |
| `showAlbum` | `false` | Vis album-tittel under artist når tilgjengelig. |
| `cardMinWidth` | `150` | Minimumsbredde for kort når rad-/rutenettlayout tilpasses. |
| `debug` | `false` | Skriver ekstra informasjon i MagicMirror-konsollen.

## Tilleggsfunksjoner

- **Automatisk re-discovery:** Hvis Sonos-enheten mister kontakt prøver modulen automatisk å finne den igjen.
- **HTTPS-støtte:** Sett `forceHttps: true` dersom speilet kjører bak en proxy som oversetter til HTTPS.
- **Responsivt design:** Rad- og rutenettlayout skalerer ned på små skjermer og bytter til vertikal visning ved behov.
- **Lynrask status:** Polling kombineres med caching slik at grensesnittet oppdateres uten merkbar forsinkelse.

## Feilsøking

- Sett `debug: true` for å se hva som skjer i både modul og node_helper (i MagicMirror-konsollen).
- Øk `discoveryTimeout` dersom du ikke får kontakt. På mesh-nettverk kan 10000–15000 ms være passende.
- Kjør `npm install` på nytt dersom du får beskjed om manglende avhengigheter.
- Albumart mangler? Prøv `forceHttps: true` dersom MagicMirror lastes over HTTPS og browseren blokkerer HTTP-bilder.

## Videre arbeid

Forslag til videre forbedringer:

- Legge til volumkontroll via Touch/Remote notifications.
- Vise avspillingskilde (Spotify, Radio, Line-in) med ikon.
- Integrere enkel fremdriftsindikator for pågående spor.
- Cache albumbilder lokalt for raskere lastetid på trege nett.

## Lisens

Publisert under [MIT-lisensen](LICENSE). Bidrag og pull requests er hjertelig velkommen!
