"""
make_qr.py

Generates the printed QR code for the poster beside the board.

    python make_qr.py      ->  print/qr-scan.svg

Needs segno (pip install segno). The output is committed; print/ is deliberately
NOT in the build.sh allowlist, so none of it is deployed.

What it encodes
---------------
https://symmetryboard.co.uk/scan — never the app URL directly. /scan is a 302 in
_redirects (currently to /?src=qr, which opens the welcome/install screen), so where
the printed code lands can be changed later without reprinting anything. Keep the
path lowercase: /SCAN would 404.

Print-robustness choices
------------------------
  error correction Q   ~25% of the code can be damaged or glared and still scan
  quiet zone 4         the full 4-module white margin the QR spec asks for
  black on white       inverted (light-on-dark) codes fail on some phone scanners
The SVG has no fixed width/height (omitsize), so the poster sizes it with CSS.
Print it 6–8 cm wide.
"""

from pathlib import Path

import segno

HERE = Path(__file__).resolve().parent
URL = 'https://symmetryboard.co.uk/scan'
OUT = HERE / 'print' / 'qr-scan.svg'


def main():
    qr = segno.make(URL, error='q', micro=False, boost_error=False)
    assert qr.error == 'Q', qr.error   # boost_error=False keeps it at exactly Q
    OUT.parent.mkdir(exist_ok=True)
    qr.save(OUT, kind='svg', border=4, dark='#000', light='#fff', omitsize=True,
            title='QR code: symmetryboard.co.uk/scan')
    size = qr.symbol_size(border=4)[0]
    print(f'make_qr.py: wrote {OUT.relative_to(HERE)} — {URL}, version {qr.version}, '
          f'error {qr.error}, {size}x{size} modules incl. quiet zone')
    print(f'make_qr.py: at 7 cm wide one module is {70 / size:.2f} mm')


if __name__ == '__main__':
    main()
