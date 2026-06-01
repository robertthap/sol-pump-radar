/**
 * Disjoint-set union with path compression + union by size.
 * Used by the cluster worker to merge wallets that share co-buy edges.
 */
export class UnionFind {
  private parent = new Map<string, string>();
  private size = new Map<string, number>();

  add(x: string): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.size.set(x, 1);
    }
  }

  find(x: string): string {
    this.add(x);
    let cur = x;
    while (this.parent.get(cur)! !== cur) {
      const par = this.parent.get(cur)!;
      const grandpa = this.parent.get(par)!;
      this.parent.set(cur, grandpa);
      cur = grandpa;
    }
    return cur;
  }

  union(a: string, b: string): boolean {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return false;
    const sa = this.size.get(ra)!;
    const sb = this.size.get(rb)!;
    if (sa < sb) {
      this.parent.set(ra, rb);
      this.size.set(rb, sa + sb);
    } else {
      this.parent.set(rb, ra);
      this.size.set(ra, sa + sb);
    }
    return true;
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const arr = out.get(root);
      if (arr) arr.push(node);
      else out.set(root, [node]);
    }
    return out;
  }
}
