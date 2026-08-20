import { buildProjectInDocker } from "./builder";

export async function buildProject(id: string): Promise<void> {
    return buildProjectInDocker({
        id,
        memoryLimitMb: 512,  // 512MB RAM cap
        cpuLimit: 1.0,       // 1.0 CPU Core cap
        timeoutMs: 300000,   // 5 Minutes timeout
    });
}