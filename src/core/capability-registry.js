import { PlatenError } from './errors.js';

export class CapabilityRegistry {
  constructor({ families, packs, capabilities }) {
    if (![families, packs, capabilities].every(Array.isArray)) {
      throw new PlatenError('CATALOG_INVALID', 'Capability catalog payloads must be arrays.');
    }
    this.families = Object.freeze(families.map(Object.freeze));
    this.packs = Object.freeze(packs.map(Object.freeze));
    this.capabilities = Object.freeze(capabilities.map(Object.freeze));
    this.#assertUnique(this.families, 'family');
    this.#assertUnique(this.packs, 'pack');
    this.#assertUnique(this.capabilities, 'capability');
    const familyIds = new Set(this.families.map(({ id }) => id));
    const packIds = new Set(this.packs.map(({ id }) => id));
    for (const capability of this.capabilities) {
      if (!familyIds.has(capability.familyId) || !packIds.has(capability.owner)) {
        throw new PlatenError('CATALOG_INVALID', `Capability ${capability.id} has an unknown family or owner.`);
      }
      if (!['implemented', 'planned'].includes(capability.delivery)) {
        throw new PlatenError('CATALOG_INVALID', `Capability ${capability.id} has an invalid delivery state.`);
      }
      if (capability.delivery === 'planned' && capability.evidence !== null) {
        throw new PlatenError('CATALOG_INVALID', `Planned capability ${capability.id} cannot carry implementation evidence.`);
      }
      if (capability.delivery === 'implemented' && (!capability.evidence || typeof capability.evidence.reference !== 'string')) {
        throw new PlatenError('CATALOG_INVALID', `Implemented capability ${capability.id} needs evidence.`);
      }
    }
  }

  get summary() {
    const implemented = this.capabilities.filter(({ delivery }) => delivery === 'implemented').length;
    return Object.freeze({
      families: this.families.length,
      capabilities: this.capabilities.length,
      implemented,
      planned: this.capabilities.length - implemented,
    });
  }

  capabilitiesForFamily(familyId) {
    return this.capabilities.filter((capability) => capability.familyId === familyId);
  }

  family(id) {
    return this.families.find((family) => family.id === id) ?? null;
  }

  pack(id) {
    return this.packs.find((pack) => pack.id === id) ?? null;
  }

  #assertUnique(items, label) {
    const ids = items.map(({ id }) => id);
    if (ids.some((id) => typeof id !== 'string') || new Set(ids).size !== ids.length) {
      throw new PlatenError('CATALOG_INVALID', `Duplicate or invalid ${label} IDs.`);
    }
  }
}
