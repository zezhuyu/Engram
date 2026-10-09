# Unix tools — single-run timings (macOS arm64, warm cache, 1,000,000 lines / ~35 MB, node v22+)

Measured once on a machine that was also running an unrelated benchmark build; treat as order-of-magnitude, not a benchmark gate. System tools are the BSD ones shipped with macOS (`LC_ALL=C`). Output of `sort` and `sort -n -k2,2` was byte-identical (md5) to the system's.

| Command | mdb | system |
|---|---|---|
| sort | ~4.8 s | 0.45 s |
| sort -n -k2,2 | ~4.7 s | 1.3 s |
| grep -c gamma | 0.7 s | 0.14 s |
| wc -l | 0.4 s | 0.05 s |
| cut -d' ' -f2 | 1.8 s | 0.28 s |
| uniq -c | 2.4 s | 0.21 s |
| tr a-z A-Z | 1.0 s | 1.1 s |
| head -n 5 / tail -n 5 | 0.15 s / 0.7 s | 0.03 s |

Memory: streaming tools hold one line; `sort` holds the lines (1M lines ≈ 0.5 GB RSS) and refuses beyond `MDB_UNIX_MAX_BUFFER_LINES`. The tools exist for ACL-bound vault operands and portable, bounded behaviour, not to out-run C implementations: pipe vault content into the system tools when raw speed matters.
