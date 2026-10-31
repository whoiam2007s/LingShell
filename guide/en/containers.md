# Containers & K8s

Docker, Compose and Kubernetes on your machine or on remote hosts, all in panels — no more bouncing between `docker ps` and `kubectl get`.

![Container list with logs](../assets/containers.png)

## What you get

- **Docker (local / remote)**: containers with state, image, ports and start time; start, stop, restart, remove.
- **Container logs**: follow in real time, search and export.
- **Exec into containers**: open a shell or run a single command inside.
- **Compose**: map compose projects to services, inspect and act per project.
- **Kubernetes**: uses your local `kubectl` config (switchable context / namespace) to browse Pods, Deployments, Services, Nodes and more; events, logs and describe included.
- **Remote over SSH**: Docker / K8s on a remote host share the same SSH connection — no extra tunnel.
- **AI hand-off**: when a container misbehaves or a Pod crash-loops, let the AI combine logs and events.

## How to use it

1. Open the container panel and pick local or a host.
2. Check state first; open logs for anything unhealthy.
3. Exec into the container when you need to dig in (writes require approval).
4. For Kubernetes, switch context / namespace before browsing resources.

## Notes

- Removing containers or recreating services is irreversible and requires approval.
- On production clusters, prefer read-only browsing plus AI analysis, and ship changes through your normal release process.

## Related

- [Ops & troubleshooting](ops.md) · [Hosts & connections](hosts.md) · [Automation & inspections](automation.md)
