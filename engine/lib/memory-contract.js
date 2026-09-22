export class AtomicMemoryGraph {
    entities = new Map();
    relations = new Map();
    relationTypes;
    revision = 0;
    onResourceUpdated;
    constructor(options = {}) {
        this.relationTypes = options.relationTypes ? new Set(options.relationTypes.map(validateNonEmpty)) : null;
        this.onResourceUpdated = options.onResourceUpdated ?? (() => { });
    }
    createEntities(input) {
        if (!Array.isArray(input))
            throw new TypeError('entities 必须是数组');
        const normalized = input.map(normalizeEntity);
        const pending = new Map();
        for (const entity of normalized) {
            if (!this.entities.has(entity.name) && !pending.has(entity.name))
                pending.set(entity.name, entity);
        }
        const created = [...pending.values()].map(cloneEntity);
        for (const entity of pending.values())
            this.entities.set(entity.name, entity);
        this.updated('create_entities', created.length);
        return created;
    }
    createRelations(input) {
        if (!Array.isArray(input))
            throw new TypeError('relations 必须是数组');
        const normalized = input.map((raw) => normalizeRelation(raw, this.relationTypes));
        for (const relation of normalized) {
            if (!this.entities.has(relation.from) || !this.entities.has(relation.to)) {
                throw new Error(`relation endpoint missing: ${relation.from} -> ${relation.to}`);
            }
        }
        const pending = new Map();
        for (const relation of normalized) {
            const key = relationKey(relation);
            if (!this.relations.has(key) && !pending.has(key))
                pending.set(key, relation);
        }
        const created = [...pending.values()].map((relation) => ({ ...relation }));
        for (const [key, relation] of pending)
            this.relations.set(key, relation);
        this.updated('create_relations', created.length);
        return created;
    }
    addObservations(input) {
        if (!Array.isArray(input))
            throw new TypeError('observations input 必须是数组');
        const normalized = input.map((item) => ({ entityName: validateNonEmpty(item.entityName), contents: atomicStrings(item.contents) }));
        for (const item of normalized)
            if (!this.entities.has(item.entityName))
                throw new Error(`entity not found: ${item.entityName}`);
        const staged = new Map();
        for (const item of normalized) {
            const entity = this.entities.get(item.entityName);
            const prior = staged.get(item.entityName) ?? [];
            const added = item.contents.filter((value) => !entity.observations.includes(value) && !prior.includes(value));
            staged.set(item.entityName, [...prior, ...added]);
        }
        const result = normalized.map(({ entityName }) => ({ entityName, addedObservations: [...(staged.get(entityName) ?? [])] }));
        for (const [entityName, added] of staged)
            this.entities.get(entityName).observations.push(...added);
        this.updated('add_observations', [...staged.values()].reduce((sum, values) => sum + values.length, 0));
        return result;
    }
    deleteEntities(names) {
        const deleted = [];
        const notFound = [];
        for (const name of names.map(validateNonEmpty)) {
            if (this.entities.delete(name))
                deleted.push(name);
            else
                notFound.push(name);
        }
        if (deleted.length > 0) {
            for (const [key, relation] of this.relations) {
                if (deleted.includes(relation.from) || deleted.includes(relation.to))
                    this.relations.delete(key);
            }
        }
        this.updated('delete_entities', deleted.length);
        return { deleted, notFound };
    }
    deleteObservations(input) {
        if (!Array.isArray(input))
            throw new TypeError('observations input 必须是数组');
        const normalized = input.map((item) => ({ entityName: validateNonEmpty(item.entityName), observations: atomicStrings(item.observations) }));
        for (const item of normalized)
            if (!this.entities.has(item.entityName))
                throw new Error(`entity not found: ${item.entityName}`);
        const staged = new Map();
        let changed = 0;
        for (const item of normalized) {
            const entity = this.entities.get(item.entityName);
            const remove = new Set(item.observations);
            const next = (staged.get(item.entityName) ?? entity.observations).filter((value) => !remove.has(value));
            staged.set(item.entityName, next);
        }
        for (const [entityName, next] of staged) {
            const entity = this.entities.get(entityName);
            changed += entity.observations.length - next.length;
            entity.observations = next;
        }
        this.updated('delete_observations', changed);
        return { deleted: changed };
    }
    deleteRelations(input) {
        if (!Array.isArray(input))
            throw new TypeError('relations 必须是数组');
        const normalized = input.map((raw) => normalizeRelation(raw, this.relationTypes));
        const keys = [...new Set(normalized.map(relationKey))];
        const deleted = keys.filter((key) => this.relations.has(key)).length;
        for (const key of keys)
            this.relations.delete(key);
        this.updated('delete_relations', deleted);
        return { deleted };
    }
    readGraph() {
        return {
            entities: [...this.entities.values()].map(cloneEntity),
            relations: [...this.relations.values()].map((relation) => ({ ...relation })),
            revision: this.revision,
            resource: 'memory://knowledge-graph',
        };
    }
    searchNodes(query) {
        const needle = validateNonEmpty(query).toLowerCase();
        const selected = new Set([...this.entities.values()].filter((entity) => [entity.name, entity.entityType, ...entity.observations].join(' ').toLowerCase().includes(needle)).map((entity) => entity.name));
        return {
            entities: [...selected].map((name) => cloneEntity(this.entities.get(name))),
            relations: [...this.relations.values()].filter((relation) => selected.has(relation.from) || selected.has(relation.to)).map((relation) => ({ ...relation })),
        };
    }
    openNodes(names) {
        const selected = new Set(names.map(validateNonEmpty));
        return {
            entities: [...selected].flatMap((name) => {
                const entity = this.entities.get(name);
                return entity ? [cloneEntity(entity)] : [];
            }),
            relations: [...this.relations.values()].filter((relation) => selected.has(relation.from) || selected.has(relation.to)).map((relation) => ({ ...relation })),
        };
    }
    updated(operation, changes) {
        if (changes < 1)
            return;
        this.revision += 1;
        this.onResourceUpdated({ uri: 'memory://knowledge-graph', revision: this.revision, operation });
    }
}
function normalizeEntity(raw) {
    return { name: validateNonEmpty(raw?.name), entityType: validateNonEmpty(raw?.entityType), observations: atomicStrings(raw?.observations ?? []) };
}
function normalizeRelation(raw, allowed) {
    const relation = { from: validateNonEmpty(raw?.from), to: validateNonEmpty(raw?.to), relationType: validateNonEmpty(raw?.relationType) };
    if (allowed && !allowed.has(relation.relationType))
        throw new Error(`unsupported relationType: ${relation.relationType}`);
    return relation;
}
function atomicStrings(values) {
    if (!Array.isArray(values))
        throw new TypeError('observations 必须是字符串数组');
    return [...new Set(values.map(validateNonEmpty))];
}
function validateNonEmpty(value) {
    if (typeof value !== 'string' || value.trim() === '')
        throw new TypeError('值必须是非空字符串');
    return value.trim();
}
function relationKey(relation) {
    return `${relation.from}\u0000${relation.relationType}\u0000${relation.to}`;
}
function cloneEntity(entity) {
    return { ...entity, observations: [...entity.observations] };
}
