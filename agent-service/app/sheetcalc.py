"""Spreadsheet formulas worked out for previews, when a file was saved without its results (made by a program, not
by Excel). A small, safe subset: numbers, text, cell and range references (also on other sheets), + - * / ^ & and
comparisons, and SUM, AVERAGE, MIN, MAX, COUNT, COUNTA, ROUND, ABS, IF, AND, OR, CONCAT. Anything else shows
#NAME? and broken references #REF!, the way Excel shows them; nothing is ever run as code beyond these.
"""
import ast
import operator
import re
from typing import Any

from openpyxl.utils import column_index_from_string, get_column_letter

REF = re.compile(r"(?:(?:'([^']+)'|([A-Za-z_][\w.]*))!)?\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?")


class SheetError(Exception):
    pass


def _num(v: Any) -> float:
    if v in (None, ""):
        return 0.0
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)):
        return float(v)
    try:
        return float(str(v).replace(",", ""))
    except ValueError:
        raise SheetError("#VALUE!") from None


def _flat(args: tuple) -> list:
    out: list = []
    for a in args:
        out += _flat(tuple(a)) if isinstance(a, list) else [a]
    return out


def _nums(args: tuple) -> list[float]:
    return [float(v) for v in _flat(args) if isinstance(v, (int, float)) and not isinstance(v, bool)]


FUNCS = {
    "SUM": lambda *a: sum(_nums(a)),
    "AVERAGE": lambda *a: (sum(_nums(a)) / len(_nums(a))) if _nums(a) else (_ for _ in ()).throw(SheetError("#DIV/0!")),
    "MIN": lambda *a: min(_nums(a), default=0.0),
    "MAX": lambda *a: max(_nums(a), default=0.0),
    "COUNT": lambda *a: float(len(_nums(a))),
    "COUNTA": lambda *a: float(sum(v not in (None, "") for v in _flat(a))),
    "ROUND": lambda v, d=0: round(_num(v), int(_num(d))),
    "ABS": lambda v: abs(_num(v)),
    "IF": lambda c, a=True, b=False: a if c else b,
    "AND": lambda *a: all(_flat(a)),
    "OR": lambda *a: any(_flat(a)),
    "CONCAT": lambda *a: "".join("" if v is None else str(v) for v in _flat(a)),
}
BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv, ast.Pow: operator.pow}
CMP = {ast.Eq: operator.eq, ast.NotEq: operator.ne, ast.Lt: operator.lt, ast.LtE: operator.le, ast.Gt: operator.gt, ast.GtE: operator.ge}


class Book:
    """Every sheet's cells as saved ({sheet: {"A1": value or "=formula"}}); `value` works formulas out, once each."""

    def __init__(self, sheets: dict[str, dict[str, Any]]):
        self.sheets = sheets
        self.done: dict[tuple[str, str], Any] = {}
        self.busy: set[tuple[str, str]] = set()

    def value(self, sheet: str, cell: str) -> Any:
        key = (sheet, cell)
        if key in self.done:
            return self.done[key]
        if sheet not in self.sheets:
            raise SheetError("#REF!")
        raw = self.sheets[sheet].get(cell)
        if not (isinstance(raw, str) and raw.startswith("=")):
            return raw
        if key in self.busy:
            raise SheetError("#CYCLE!")
        self.busy.add(key)
        try:
            out = self._formula(sheet, raw[1:])
        except SheetError as e:
            out = str(e)
        except (ZeroDivisionError,):
            out = "#DIV/0!"
        except Exception:
            out = "#ERROR!"
        finally:
            self.busy.discard(key)
        self.done[key] = out
        return out

    def _formula(self, sheet: str, f: str) -> Any:
        refs: list[Any] = []

        def sub(m: re.Match) -> str:
            at = m.group(1) or m.group(2) or sheet
            c1, r1, c2, r2 = m.group(3), int(m.group(4)), m.group(5), m.group(6)
            if c2:
                cols = range(column_index_from_string(c1), column_index_from_string(c2) + 1)
                rows = range(r1, int(r2) + 1)
                refs.append([self._plain(at, f"{get_column_letter(c)}{r}") for r in rows for c in cols])
            else:
                refs.append(self._plain(at, f"{c1}{r1}"))
            return f"__ref{len(refs) - 1}"

        # strings first, so their insides aren't read as references
        texts: list[str] = []
        f = re.sub(r'"((?:[^"]|"")*)"', lambda m: (texts.append(m.group(1).replace('""', '"')), f"__txt{len(texts) - 1}")[1], f)
        f = REF.sub(sub, f)
        f = f.replace("<>", "!=").replace("^", "**").replace("&", " % ")  # & joins text: mapped to % below
        f = re.sub(r"(?<![<>!=])=(?!=)", "==", f)
        tree = ast.parse(f.strip(), mode="eval")
        return self._eval(tree.body, refs, texts)

    def _plain(self, sheet: str, cell: str) -> Any:
        v = self.value(sheet, cell)
        if isinstance(v, str) and v.startswith("#"):
            raise SheetError(v)
        return v

    def _eval(self, n: ast.AST, refs: list, texts: list[str]) -> Any:
        ev = lambda x: self._eval(x, refs, texts)  # noqa: E731
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)):
            return float(n.value)
        if isinstance(n, ast.Name):
            if n.id.startswith("__ref"):
                return refs[int(n.id[5:])]
            if n.id.startswith("__txt"):
                return texts[int(n.id[5:])]
            if n.id.upper() in ("TRUE", "FALSE"):
                return n.id.upper() == "TRUE"
            raise SheetError("#NAME?")
        if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Mod):  # &
            return f"{_text(ev(n.left))}{_text(ev(n.right))}"
        if isinstance(n, ast.BinOp) and type(n.op) in BIN:
            return BIN[type(n.op)](_num(ev(n.left)), _num(ev(n.right)))
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, (ast.USub, ast.UAdd)):
            v = _num(ev(n.operand))
            return -v if isinstance(n.op, ast.USub) else v
        if isinstance(n, ast.Compare) and len(n.ops) == 1 and type(n.ops[0]) in CMP:
            a, b = ev(n.left), ev(n.comparators[0])
            if isinstance(a, (int, float)) or isinstance(b, (int, float)):
                a, b = _num(a), _num(b)
            return CMP[type(n.ops[0])](a, b)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id.upper() in FUNCS and not n.keywords:
            return FUNCS[n.func.id.upper()](*[ev(a) for a in n.args])
        raise SheetError("#NAME?")


def _text(v: Any) -> str:
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return "" if v is None else str(v)


def show(v: Any) -> str:
    """A cell as the preview prints it."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, float):
        return str(int(v)) if v.is_integer() else f"{v:,.2f}".rstrip("0").rstrip(".") if abs(v) < 1e15 else f"{v:g}"
    if isinstance(v, int):
        return str(v)
    return str(v)


if __name__ == "__main__":
    b = Book({"Budget": {"B2": 100, "C2": 40, "D2": "=B2-C2", "B3": 50, "C3": "=B3/2", "D3": "=B3-C3", "D4": "=SUM(D2:D3)",
                         "E1": '="Left: "&D4', "F1": "=IF(D4>50,\"over\",\"under\")", "G1": "=Team!A1*2", "H1": "=FOO(1)",
                         "I1": "=I1+1", "J1": "=AVERAGE(B2:B3)", "K1": "=ROUND(10/3,2)"},
              "Team": {"A1": 21}})
    got = {c: b.value("Budget", c) for c in ["D2", "D3", "D4", "E1", "F1", "G1", "H1", "I1", "J1", "K1"]}
    assert got == {"D2": 60.0, "D3": 25.0, "D4": 85.0, "E1": "Left: 85", "F1": "over", "G1": 42.0, "H1": "#NAME?",
                   "I1": "#CYCLE!", "J1": 75.0, "K1": 3.33}, got
    assert show(1234.5) == "1,234.5" and show(60.0) == "60"
    print("ok")
