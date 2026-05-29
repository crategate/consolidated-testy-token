import { useEffect, useState } from 'react';
import { type ResolvedDeployment, resolveDeployment } from '../config';

type DeploymentState = {
    deployment: ResolvedDeployment | null;
    loading: boolean;
    error: string | null;
};

export function useDeployment(): DeploymentState {
    const [deployment, setDeployment] = useState<ResolvedDeployment | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;

        async function load() {
            try {
                const response = await fetch(`/deployment.json?t=${Date.now()}`, {
                    cache: 'no-store',
                });
                const config = response.ok ? await response.json() : {};
                const resolved = resolveDeployment(config);

                if (!cancelled) {
                    setDeployment(resolved);
                    setError(null);
                }
            } catch (err) {
                if (!cancelled) {
                    setError(err instanceof Error ? err.message : 'Failed to load deployment');
                    setDeployment(null);
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        }

        load();

        return () => {
            cancelled = true;
        };
    }, []);

    return { deployment, loading, error };
}
