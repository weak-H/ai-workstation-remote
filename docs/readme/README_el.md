<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Türkçe](README_tr.md) · [Русский](README_ru.md) · [Tiếng Việt](README_vi.md) · [ไทย](README_th.md) · [Deutsch](README_de.md) · [Español](README_es.md) · [Français](README_fr.md) · [Українська](README_uk.md) · [Polski](README_pl.md) · [Português (Brasil)](README_pt-BR.md) · [العربية](README_ar.md) · [فارسی](README_fa.md) · [Bahasa Indonesia](README_id.md) · [Italiano](README_it.md) · **Ελληνικά** · [മലയാളം](README_ml.md)

# AI Workstation Remote

### Ελέγξτε τοπικές συνεδρίες προγραμματισμού AI από κάθε αξιόπιστο πρόγραμμα περιήγησης

</div>

## Στιγμιότυπα οθόνης

<p align="center">
  <img src="../images/workbench.jpg" alt="AI Workstation Remote workbench" width="30%">
  <img src="../images/task-conversation.jpg" alt="AI Workstation Remote task conversation" width="30%">
</p>

Το AI Workstation Remote είναι ένα local-first και ανεξάρτητο από προμηθευτές επίπεδο ελέγχου Web. Εμφανίζει πραγματικές συνεδρίες Codex, Cursor και Claude Code από macOS ή Windows στο πρόγραμμα περιήγησης ενός τηλεφώνου, tablet, φορητού υπολογιστή ή άλλης αξιόπιστης συσκευής. Επιστρέφει στον σταθμό εργασίας υποστηριζόμενα μηνύματα, αιτήματα διακοπής και εγκρίσεις. Δεν είναι απομακρυσμένη επιφάνεια εργασίας ούτε κέλυφος απομακρυσμένης πρόσβασης γενικής χρήσης.

> [!WARNING]
> Το έργο είναι πρωτότυπο υπό ανάπτυξη. Το ενσωματωμένο Cloudflare Quick Tunnel προορίζεται για ανάπτυξη και δοκιμές, όχι για ευαίσθητα αποθετήρια ή παραγωγή.

Αυτή είναι μεταφρασμένη επισκόπηση. Το [αγγλικό README](../../README.md) αποτελεί την αναφορά για την πλήρη συμπεριφορά, τις ρυθμίσεις και τα τρέχοντα όρια ασφαλείας.

## Γρήγορη εκκίνηση

Απαιτούνται macOS (Apple Silicon ή Intel) ή Windows 10/11, Node.js 22.5+ και τουλάχιστον ένας υποστηριζόμενος τοπικός πελάτης.

```bash
caffeinate -i ./run.sh
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

Ο εκκινητής δημιουργεί τη διεπαφή, ξεκινά relay και Companion, ανοίγει προσωρινό tunnel και εμφανίζει URL προσβάσιμο από άλλες συσκευές. Κρατήστε το τερματικό ανοικτό· το `Ctrl+C` σταματά τις υπηρεσίες και ακυρώνει το δημόσιο URL. Η προεπιλεγμένη τοπική διεύθυνση είναι `http://127.0.0.1:8787`.

## Ενσωματώσεις

- **Codex**: app-server, επίσημο CLI και Desktop IPC όταν είναι διαθέσιμο.
- **Cursor**: ανάγνωση του τοπικού αποθηκευτικού χώρου· Desktop Bridge ή τοπική επέκταση relay.
- **Claude Code**: ανάγνωση ιστορικού JSONL και συνέχεια μέσω του εγκατεστημένου CLI.

Τα διαπιστευτήρια μοντέλων μένουν στον σταθμό εργασίας. Αν ο έλεγχος εγγραφής δεν αποκτηθεί με ασφάλεια, η συνεδρία παραμένει μόνο για ανάγνωση.

## Ανάπτυξη

```bash
npm install
npm run dev
npm test
npm run typecheck
```

## Ασφάλεια και άδεια

Η τρέχουσα απομακρυσμένη πρόσβαση χρησιμοποιεί προσωρινό HTTPS/WSS tunnel και τυχαίο bearer token στο URL. Ταυτότητα συσκευής, υπογεγραμμένες εντολές και κρυπτογράφηση end-to-end παραγωγής δεν έχουν ακόμη υλοποιηθεί. Δείτε την [πολιτική ασφαλείας](../../SECURITY.md) και το [μοντέλο ασφαλείας](../security.md).

Ο κώδικας και η τεκμηρίωση του έργου διατίθενται με [άδεια MIT](../../LICENSE). Τα στοιχεία τρίτων διατηρούν τις δικές τους άδειες· δείτε τις [ειδοποιήσεις](../../THIRD_PARTY_NOTICES.md), τον [οδηγό συνεισφοράς](../../CONTRIBUTING.md) και τον [κώδικα δεοντολογίας](../../CODE_OF_CONDUCT.md).
