export interface MemoryEntity {
    name: string;
    entityType: string;
    observations: string[];
}
export interface MemoryRelation {
    from: string;
    to: string;
    relationType: string;
}
export interface MemoryResourceUpdate {
    uri: 'memory://knowledge-graph';
    revision: number;
    operation: string;
}
export declare class AtomicMemoryGraph {
    private readonly entities;
    private readonly relations;
    private readonly relationTypes;
    private revision;
    private readonly onResourceUpdated;
    constructor(options?: {
        relationTypes?: string[];
        onResourceUpdated?: (event: MemoryResourceUpdate) => void;
    });
    createEntities(input: MemoryEntity[]): MemoryEntity[];
    createRelations(input: MemoryRelation[]): {
        from: string;
        to: string;
        relationType: string;
    }[];
    addObservations(input: Array<{
        entityName: string;
        contents: string[];
    }>): {
        entityName: string;
        addedObservations: string[];
    }[];
    deleteEntities(names: string[]): {
        deleted: string[];
        notFound: string[];
    };
    deleteObservations(input: Array<{
        entityName: string;
        observations: string[];
    }>): {
        deleted: number;
    };
    deleteRelations(input: MemoryRelation[]): {
        deleted: number;
    };
    readGraph(): {
        entities: MemoryEntity[];
        relations: {
            from: string;
            to: string;
            relationType: string;
        }[];
        revision: number;
        resource: "memory://knowledge-graph";
    };
    searchNodes(query: string): {
        entities: MemoryEntity[];
        relations: {
            from: string;
            to: string;
            relationType: string;
        }[];
    };
    openNodes(names: string[]): {
        entities: MemoryEntity[];
        relations: {
            from: string;
            to: string;
            relationType: string;
        }[];
    };
    private updated;
}
