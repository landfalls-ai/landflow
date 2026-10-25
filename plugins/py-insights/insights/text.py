"""Small, dependency-free text helpers: dot paths, tokenizer, stopwords, sentiment lexicon."""

from __future__ import annotations

import re
from typing import Any

_MISSING = object()


def get_path(obj: Any, path: str, default: Any = None) -> Any:
    """``get_path({"a": {"b": 1}}, "a.b") == 1``. A literal key containing dots wins."""
    if isinstance(obj, dict) and path in obj:
        return obj[path]
    current = obj
    for part in path.split("."):
        if isinstance(current, dict) and part in current:
            current = current[part]
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return default
    return current


def set_path(obj: dict, path: str, value: Any) -> None:
    """Set ``obj["a"]["b"] = value`` for ``"a.b"``, creating intermediate dicts."""
    parts = path.split(".")
    current = obj
    for part in parts[:-1]:
        nxt = current.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            current[part] = nxt
        current = nxt
    current[parts[-1]] = value


# Letters only (any script), allowing inner apostrophes: "don't", "l'eau".
_WORD_RE = re.compile(r"[^\W\d_]+(?:['’][^\W\d_]+)*", re.UNICODE)


def tokenize(text: str) -> list[str]:
    return [t.replace("’", "'") for t in _WORD_RE.findall(text.lower())]


# ---------------------------------------------------------------------------
# Stopwords
# ---------------------------------------------------------------------------

LANGUAGE_NAMES = {
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "pt": "Portuguese",
    "it": "Italian",
    "none": "None (keep every word)",
}

STOPWORDS: dict[str, frozenset[str]] = {
    "en": frozenset(
        """a about above after again against all also am an and any are aren't as at be because been
        before being below between both but by can can't cannot could couldn't did didn't do does doesn't
        doing don't down during each else even ever every few for from further get gets got had hadn't has
        hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how
        how's however i i'd i'll i'm i've if in into is isn't it it's its itself just let's like made make
        many may me might more most much must mustn't my myself no nor not now of off on once one only or
        other ought our ours ourselves out over own really said same say says shan't she she'd she'll
        she's should shouldn't since so some still such than that that's the their theirs them themselves
        then there there's these they they'd they'll they're they've thing things this those though
        through to too under until up upon us very was wasn't way we we'd we'll we're we've well were
        weren't what what's when when's where where's whether which while who who's whom why why's will
        with within without won't would wouldn't yet you you'd you'll you're you've your yours yourself
        yourselves""".split()
    ),
    "es": frozenset(
        """a al algo algunos ante antes como con contra cual cuando de del desde donde durante e el ella
        ellas ellos en entre era es esa ese eso esta estaba estado estar este esto estos fue fueron ha
        hasta hay la las le les lo los mas me mi mis mucho muy más nada ni no nos nosotros o otra otro
        para pero poco por porque que quien se sea ser si sin sobre son su sus también te tiene todo
        todos tu tus un una uno unos y ya yo""".split()
    ),
    "fr": frozenset(
        """a ai au aux avec avait ce ces cette dans de des du elle elles en est et été être il ils je
        la le les leur leurs lui ma mais me mes moi mon même ne nos notre nous on ou où par pas pour
        qu que qui sa se ses son sont sur ta te tes toi ton tous tout très tu un une vos votre vous y
        c'est d'un d'une l'on n'est qu'il""".split()
    ),
    "de": frozenset(
        """aber alle als also am an auch auf aus bei bin bis da damit dann das dass dem den der des die
        dies diese dieser dir doch dort du durch ein eine einem einen einer eines er es für hat hatte
        hier ich ihr im in ist ja jetzt kann kein mich mir mit nach nicht noch nur oder schon sehr sich
        sie sind so um und uns unter vom von vor war was weil wenn wer wie wir wird zu zum zur über""".split()
    ),
    "pt": frozenset(
        """a ao aos as até com como da das de dela dele do dos e ela elas ele eles em entre era essa esse
        esta este eu foi isso isto já lhe mais mas me mesmo meu minha muito na nas nem no nos não o os
        ou para pela pelo por qual quando que quem se sem ser seu sua são também te tem um uma você""".split()
    ),
    "it": frozenset(
        """a ad al alla alle anche che chi ci come con da dal dalla dei del della delle di dove e ed era
        gli ha hanno il in io la le lei lo loro lui ma mi mio molto ne nei nel nella noi non o per perché
        più quando quella quello questa questo se si sono su sua suo tra tu un una uno voi è""".split()
    ),
    "none": frozenset(),
}


def stopwords_for(language: str) -> frozenset[str]:
    return STOPWORDS.get((language or "en").lower(), STOPWORDS["en"])


# ---------------------------------------------------------------------------
# Sentiment lexicon (AFINN-style weights, -3..+3)
# ---------------------------------------------------------------------------

_LEXICON_SPEC = {
    3: "amazing awesome brilliant delighted delightful excellent exceptional fantastic flawless "
    "incredible love loved loves magnificent outstanding perfect phenomenal superb thrilled wonderful",
    2: "admire appreciate appreciated beautiful best calm charming cheerful clean comfortable "
    "convenient cool easy effective efficient elegant enjoy enjoyed enjoyable excited exciting fast "
    "favorite favourite fun glad good grateful great happy helpful impressed impressive intuitive "
    "kind lovely nice pleasant pleased powerful recommend recommended reliable remarkable satisfied "
    "smooth solid stable success successful thank thanks useful valuable win winning",
    1: "accurate affordable better clear correct decent fair fine fixed improve improved improvement "
    "liked likes ok okay positive quick ready resolved safe simple sure support supported welcome works",
    -1: "average complicated sorry concern concerned confusing delay delayed difficult doubt expensive "
    "hard issue issues lacking late mediocre meh missing negative odd problem problems slow strange "
    "unclear unfortunately unsure wait waiting worse",
    -2: "angry annoyed annoying bad boring broken bug buggy crash crashed crashes damaged disappoint "
    "disappointed disappointing dislike error errors fail failed failing fails failure frustrated "
    "frustrating hate hated lost overpriced poor refund rude sad stuck ugly unhappy unreliable "
    "unusable useless wrong",
    -3: "abysmal appalling atrocious awful catastrophe disaster disastrous disgusting dreadful furious "
    "garbage horrible horrendous nightmare pathetic scam terrible trash worst",
}

LEXICON: dict[str, int] = {word: weight for weight, words in _LEXICON_SPEC.items() for word in words.split()}

NEGATORS = frozenset(
    "not no never none nobody nothing neither nor nowhere hardly barely without cannot "
    "isn't aren't wasn't weren't don't doesn't didn't won't wouldn't can't couldn't shouldn't "
    "haven't hasn't hadn't ain't".split()
)

INTENSIFIERS = {
    "very": 1.5, "really": 1.4, "extremely": 1.8, "super": 1.5, "so": 1.3, "incredibly": 1.7,
    "absolutely": 1.6, "terribly": 1.5, "awfully": 1.5, "totally": 1.5, "truly": 1.4, "highly": 1.4, "quite": 1.2, "too": 1.2,
    "slightly": 0.6, "somewhat": 0.7, "kinda": 0.7, "bit": 0.7,
}

NEGATION_WINDOW = 3  # a negator flips sentiment words up to 3 tokens later
