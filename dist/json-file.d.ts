export declare class JsonFile<T> {
    private readonly path;
    private readonly initial;
    private queue;
    constructor(path: string, initial: () => T);
    read(): Promise<T>;
    /**
     * Return the next state from the current one. Returning the same reference
     * is a no-op: the read is serialized, but no replacement is written.
     */
    update(mutate: (current: T) => T | Promise<T>): Promise<T>;
    private enqueue;
    private readNow;
    private writeNow;
}
