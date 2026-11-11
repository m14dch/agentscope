/**
 * Which architecture groups are expanded as the cursor moves and the learner toggles
 * (02-ui-ux.yaml modes.architecture_groups): the group the cursor enters expands, a group the
 * cursor expanded collapses when the cursor leaves it, and the learner's own choices stand
 * until the cursor enters that group again.
 */
export class Expansion {
  /** Groups the learner expanded; they keep their state while the learner steps. */
  private readonly chosen = new Set<string>();
  /** The group the cursor expanded, unless the learner collapsed or took it over. */
  private auto: string | undefined;
  /** The current group at the last follow(). */
  private current: string | undefined;

  /** The set to lay out with: the learner's groups and the one the cursor opened. */
  get expanded(): ReadonlySet<string> {
    const all = new Set(this.chosen);
    if (this.auto !== undefined) all.add(this.auto);
    return all;
  }

  has(key: string): boolean {
    return this.chosen.has(key) || this.auto === key;
  }

  /** Follows the current group (undefined: none); entering a group expands it. */
  follow(key: string | undefined): void {
    if (key === this.current) return;
    this.current = key;
    this.auto = key !== undefined && !this.chosen.has(key) ? key : undefined;
  }

  /** The learner expands or collapses a group. */
  toggle(key: string): void {
    if (this.has(key)) {
      this.chosen.delete(key);
      if (this.auto === key) this.auto = undefined;
    } else this.chosen.add(key);
  }
}
