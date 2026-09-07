/**
 * Owner of the single <style> element the extension injects into the page.
 *
 * WHY a stylesheet instead of `el.style.setProperty(...)`:
 * React (and every other VDOM framework) re-writes the whole `style` attribute
 * of a node on every re-render, so an inline declaration we wrote is gone a
 * frame later and we would have to fight it with a MutationObserver loop.
 * A rule in our own stylesheet lives outside the element, survives re-renders
 * untouched, and — carrying `!important` — still beats the framework's inline
 * style, which is the highest-priority origin apart from important declarations.
 *
 * Elements are addressed by a token list in `data-dm-id` (space separated) so
 * that several changes can style the same element without any of them owning
 * the attribute, and so re-tagging a freshly rendered node is a one-attribute
 * write rather than a stylesheet rewrite.
 */

import { DM_ID_ATTR, DM_INSERTED_ATTR, DM_STYLE_ELEMENT_ID } from '@/shared/constants';
import { log } from '@/shared/logger';

/** One CSS declaration we own, keyed by property inside a change's rule. */
interface Declaration {
  value: string;
  important: boolean;
}

/** Longest property name we will emit; anything longer is certainly junk. */
const MAX_PROPERTY_LENGTH = 64;

/**
 * Longest value we will emit. Generous because legitimate values include
 * `url("data:image/png;base64,...")` blobs pasted in DevTools.
 */
const MAX_VALUE_LENGTH = 8192;

/**
 * Standard properties, vendor-prefixed properties and custom properties.
 * Anything else cannot be a real declaration and is dropped rather than
 * escaped, because there is no escape that makes a garbage property useful.
 */
const PROPERTY_RE = /^(--[a-zA-Z0-9_-]+|-?[a-zA-Z][a-zA-Z0-9-]*)$/;

/**
 * Change ids come from `uid()`. Anything with whitespace or quoting characters
 * cannot be expressed in an attribute-token selector, so we refuse it instead
 * of emitting a rule that silently matches nothing (or, worse, matches more).
 */
const CHANGE_ID_RE = /^[A-Za-z0-9_.:-]+$/;

/** Control characters make a value unusable; there is no safe escaping for them. */
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Split a `data-dm-id` attribute into its tokens, ignoring empty runs. */
function tokensOf(raw: string | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const t of raw.split(/\s+/)) if (t) out.push(t);
  return out;
}

/**
 * Selector for one change id.
 *
 * The attribute selector is repeated on purpose: it doubles our specificity to
 * (0,2,0) for free (the match set is identical) which lets us win against a
 * page rule of equal-or-lower specificity that also uses `!important`.
 * Returns '' for an id we cannot express safely.
 */
function selectorFor(changeId: string): string {
  if (!CHANGE_ID_RE.test(changeId)) return '';
  const attr = `[${DM_ID_ATTR}~="${changeId}"]`;
  return attr + attr;
}

/** Normalise + reject a property name. Returns '' when unusable. */
function safeProperty(property: string): string {
  const p = property.trim();
  if (!p || p.length > MAX_PROPERTY_LENGTH) return '';
  return PROPERTY_RE.test(p) ? p : '';
}

/**
 * Normalise a declaration value.
 *
 * Returns '' for "the user cleared this declaration" and `null` for "this value
 * is not safe to emit". We reject anything that could terminate our rule block
 * (`{` / `}`) or the host <style> element (`</`), plus control characters.
 * Interior semicolons are allowed because data-URI values legitimately contain
 * them, and without a closing brace the worst a semicolon can do is add another
 * declaration to a rule that already targets exactly the user's element.
 */
function safeValue(value: string): string | null {
  let v = value.trim();
  if (!v) return '';
  if (v.length > MAX_VALUE_LENGTH) return null;
  if (v.includes('{') || v.includes('}') || v.includes('</')) return null;
  if (CONTROL_CHARS_RE.test(v)) return null;
  // A trailing `;` or `!important` would otherwise be duplicated by us.
  v = v.replace(/;+\s*$/, '').trim();
  v = v.replace(/\s*!\s*important\s*$/i, '').trim();
  return v;
}

/**
 * A stylesheet the page cannot beat and the recorder knows to ignore.
 * Every public method swallows its own errors: this runs on hostile pages
 * where `document.head` can be replaced or our node ripped out at any moment.
 */
export class StyleManager {
  /** changeId -> (property -> declaration), both insertion-ordered. */
  private readonly decls = new Map<string, Map<string, Declaration>>();

  private el: HTMLStyleElement | null = null;

  /** Last CSS text actually written to the node; `null` forces a rewrite. */
  private written: string | null = null;

  /**
   * Create and attach the <style> node. Idempotent, and cheap enough to call
   * from every flush: at `document_start` there may be no <head> yet, so we
   * fall back to <html> and let a later call move nothing (document position
   * does not matter once every declaration is `!important`).
   */
  ensure(): void {
    try {
      if (this.el && this.el.isConnected) return;

      const existing = document.getElementById(DM_STYLE_ELEMENT_ID);
      if (existing instanceof HTMLStyleElement && existing.isConnected) {
        this.el = existing;
        // We cannot know that this node's current text is ours.
        this.written = null;
        return;
      }

      const host = document.head ?? document.documentElement;
      if (!host) return; // pre-<html>; the next flush retries

      const el = document.createElement('style');
      el.id = DM_STYLE_ELEMENT_ID;
      // Marks the node as ours so isOurNode()/the recorder never fingerprints
      // it and never records the mutations we cause here.
      el.setAttribute(DM_INSERTED_ATTR, DM_STYLE_ELEMENT_ID);
      host.appendChild(el);

      this.el = el;
      this.written = null;
    } catch (e) {
      log.error('StyleManager.ensure failed', e);
    }
  }

  /**
   * Add `changeId` to the element's `data-dm-id` token list so our rule starts
   * matching it. Called on every replay pass for freshly rendered nodes, so it
   * must not touch the DOM when the token is already present.
   */
  tag(el: Element, changeId: string): void {
    try {
      if (!CHANGE_ID_RE.test(changeId)) {
        log.error('StyleManager.tag: unusable change id', changeId);
        return;
      }
      const tokens = tokensOf(el.getAttribute(DM_ID_ATTR));
      if (tokens.includes(changeId)) return;
      tokens.push(changeId);
      el.setAttribute(DM_ID_ATTR, tokens.join(' '));
    } catch (e) {
      log.error('StyleManager.tag failed', changeId, e);
    }
  }

  /** Remove one change id from the element, dropping the attribute when empty. */
  untag(el: Element, changeId: string): void {
    try {
      const tokens = tokensOf(el.getAttribute(DM_ID_ATTR));
      if (!tokens.includes(changeId)) return;
      const rest = tokens.filter((t) => t !== changeId);
      if (rest.length === 0) el.removeAttribute(DM_ID_ATTR);
      else el.setAttribute(DM_ID_ATTR, rest.join(' '));
    } catch (e) {
      log.error('StyleManager.untag failed', changeId, e);
    }
  }

  /**
   * Register (or overwrite) one declaration for a change id. An empty value is
   * treated as a removal — a style change recorded as "" means the user deleted
   * the declaration in DevTools, and the correct replay is to stop declaring
   * it, not to invent a reset value we cannot know.
   */
  setDeclaration(changeId: string, property: string, value: string, important: boolean): void {
    try {
      const prop = safeProperty(property);
      if (!prop) {
        log.error('StyleManager: rejected property', property);
        return;
      }
      const val = safeValue(value);
      if (val === null) {
        log.error('StyleManager: rejected value for', prop);
        return;
      }
      if (val === '') {
        this.removeDeclaration(changeId, prop);
        return;
      }
      let map = this.decls.get(changeId);
      if (!map) {
        map = new Map<string, Declaration>();
        this.decls.set(changeId, map);
      }
      const prev = map.get(prop);
      if (prev && prev.value === val && prev.important === important) return;
      map.set(prop, { value: val, important });
    } catch (e) {
      log.error('StyleManager.setDeclaration failed', changeId, property, e);
    }
  }

  /** Drop one property from a change's rule. */
  removeDeclaration(changeId: string, property: string): void {
    try {
      const prop = safeProperty(property);
      if (!prop) return;
      const map = this.decls.get(changeId);
      if (!map || !map.delete(prop)) return;
      if (map.size === 0) this.decls.delete(changeId);
    } catch (e) {
      log.error('StyleManager.removeDeclaration failed', changeId, property, e);
    }
  }

  /** Forget every declaration registered under this change id. */
  clearChange(changeId: string): void {
    this.decls.delete(changeId);
  }

  /** The CSS text this change currently contributes, or '' when it has none. */
  ruleTextFor(changeId: string): string {
    const map = this.decls.get(changeId);
    if (!map || map.size === 0) return '';
    const selector = selectorFor(changeId);
    if (!selector) return '';
    return this.renderRule(selector, map);
  }

  /** Drop every rule (the node itself stays, so a later flush can refill it). */
  clear(): void {
    this.decls.clear();
  }

  /**
   * Write the pending rule text into the <style> node.
   *
   * Called once per replay pass and therefore many times a second while the
   * guard is active: it compares against the text it last wrote and performs
   * zero DOM work when nothing changed, which is what keeps the guard from
   * observing its own mutations and re-triggering itself forever.
   */
  flush(): void {
    try {
      const text = this.buildText();
      if (this.written === text && this.el && this.el.isConnected) return;

      this.ensure();
      if (!this.el) return;

      this.el.textContent = text;
      this.written = text;
    } catch (e) {
      log.error('StyleManager.flush failed', e);
    }
  }

  /**
   * Re-attach the node if the page removed (or emptied) it, then force a
   * rewrite. SPA routers and framework "reset the head" helpers do exactly
   * this, and a silently detached stylesheet means every style change quietly
   * stops applying with no other symptom.
   */
  verify(): void {
    try {
      if (!this.el || !this.el.isConnected) {
        this.el = null;
        this.ensure();
      }
      // Force the next flush even if our bookkeeping thinks it is current: the
      // page may have emptied the node without detaching it.
      this.written = null;
      this.flush();
    } catch (e) {
      log.error('StyleManager.verify failed', e);
    }
  }

  /* ---------------------------------------------------------------------- */

  /** Render one rule block. Property/value pairs are already validated. */
  private renderRule(selector: string, map: Map<string, Declaration>): string {
    const body: string[] = [];
    for (const [prop, decl] of map) {
      body.push(`  ${prop}: ${decl.value}${decl.important ? ' !important' : ''};`);
    }
    return `${selector} {\n${body.join('\n')}\n}`;
  }

  /** Full stylesheet text, in change-registration order. */
  private buildText(): string {
    if (this.decls.size === 0) return '';
    const parts: string[] = [];
    for (const [changeId, map] of this.decls) {
      if (map.size === 0) continue;
      const selector = selectorFor(changeId);
      if (!selector) continue;
      parts.push(this.renderRule(selector, map));
    }
    return parts.join('\n');
  }
}
