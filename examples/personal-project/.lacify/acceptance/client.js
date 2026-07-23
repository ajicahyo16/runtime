export class LacifyClient {
    baseUrl;
    accessToken;
    fetchImpl;
    constructor(baseUrl, accessToken, fetchImpl = fetch) {
        this.baseUrl = baseUrl;
        this.accessToken = accessToken;
        this.fetchImpl = fetchImpl;
    }
    headers(extra = {}) {
        return { 'content-type': 'application/json', authorization: `Bearer ${this.accessToken}`, ...extra };
    }
    async request(actor, partition, command, input) {
        const collection = `${actor.toLowerCase()}s`;
        const response = await this.fetchImpl(`${this.baseUrl}/v1/${collection}/${encodeURIComponent(partition)}/commands`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ command, payload: input }),
        });
        if (!response.ok)
            throw new Error(`Lacify command failed with HTTP ${response.status}.`);
        return response.json();
    }
    async commandOperation(actor, partition, operation, input, idempotencyKey) {
        const collection = `${actor.toLowerCase()}s`;
        const response = await this.fetchImpl(`${this.baseUrl}/v1/${collection}/${encodeURIComponent(partition)}/commands`, {
            method: 'POST',
            headers: this.headers(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
            body: JSON.stringify({ command: operation, payload: input }),
        });
        if (!response.ok)
            throw new Error(`Lacify operation failed with HTTP ${response.status}.`);
        return response.json();
    }
    async queryOperation(actor, partition, operation, input, page) {
        const collection = `${actor.toLowerCase()}s`;
        const response = await this.fetchImpl(`${this.baseUrl}/v1/${collection}/${encodeURIComponent(partition)}/queries/${encodeURIComponent(operation)}`, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ input, ...(page ? { page } : {}) }),
        });
        if (!response.ok)
            throw new Error(`Lacify query failed with HTTP ${response.status}.`);
        return response.json();
    }
    workspace(partition) {
        return {
            command: (command, input = {}) => this.request("Workspace", partition, command, input),
            createProject: (input, options = {}) => this.commandOperation("Workspace", partition, "CreateProject", input, options.idempotencyKey),
            getProject: (input) => this.queryOperation("Workspace", partition, "GetProject", input),
            listProjects: (input, page = {}) => this.queryOperation("Workspace", partition, "ListProjects", input, page),
        };
    }
}
export const lacifyProject = {
    "project": "personal-project-vault",
    "fingerprint": "ed907f3115c4794c63b042e5b4280d7bda1d50d7b75eb74264caf8c63b0e8a30",
    "actors": [
        "Workspace"
    ]
};
