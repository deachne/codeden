import { describe, expect, it } from "vitest";
import { classifyCommand, type RiskContext } from "../src/policy/risk";

const posix: RiskContext = {
  cwd: "/work/repo",
  platform: "linux",
  home: "/home/me",
  tempRoots: ["/tmp"],
};
const win: RiskContext = {
  cwd: "C:\\work\\repo",
  platform: "win32",
  home: "C:\\Users\\me",
  tempRoots: ["C:\\Users\\me\\AppData\\Local\\Temp"],
};

const action = (command: string, ctx: RiskContext = posix) => {
  const r = classifyCommand(command, ctx);
  return r.risky ? r.action : null;
};

/**
 * #151: a container given the host's filesystem, the Docker socket or `--privileged` reaches
 * everything the user can, so it asks like the same reach outside the worktree would.
 */
describe("container commands (#151)", () => {
  it("asks for the host filesystem, the Docker socket and privilege", () => {
    for (const [cmd, ctx] of [
      ["docker run --rm -v /:/host alpine chroot /host sh", posix],
      ["docker run -v /home/me:/h alpine sh", posix],
      ["podman run -v /:/host alpine sh", posix],
      ["nerdctl run -v /:/host alpine sh", posix],
      ["docker compose run --rm -v /:/host alpine sh", posix],
      ["docker run -v ~/.ssh:/keys alpine sh", posix],
      ["docker run --mount type=bind,source=/etc,target=/e alpine sh", posix],
      ["docker run -v C:\\Users\\me:/h alpine sh", win],
    ] as Array<[string, RiskContext]>) {
      expect(action(cmd, ctx), cmd).toBe("outside_worktree");
    }
    expect(action("docker run -v /var/run/docker.sock:/var/run/docker.sock alpine sh")).toBe(
      "outside_worktree",
    );
    expect(action("docker run --volumes-from other alpine sh")).toBe("outside_worktree");
  });

  it("asks when the container is given the host's power", () => {
    for (const cmd of [
      "docker run --privileged alpine sh",
      "podman run --privileged -v /:/host alpine sh",
      "docker run --pid=host alpine ps",
      "docker run --network host alpine sh",
      "docker run --ipc=host alpine sh",
      "docker run --user root alpine sh",
      "docker run -u 0 alpine sh",
      "docker run --cap-add SYS_ADMIN alpine sh",
      "docker run --device /dev/sda alpine sh",
      "docker run --security-opt seccomp=unconfined alpine sh",
    ]) {
      expect(action(cmd), cmd).toBe("other");
    }
  });

  it("runs ordinary container work freely", () => {
    for (const cmd of [
      "docker ps -a",
      "docker images",
      "docker build -t app .",
      "docker exec -it web sh",
      "docker run --rm -e X=1 -p 8080:80 alpine echo hi",
      "docker run --name web -d nginx",
      "docker run -u node alpine sh",
      "docker run -v ./src:/app alpine sh",
      "docker run -v /tmp/build:/app alpine sh",
      'docker run alpine sh -c "cat package.json"',
      "echo hi | docker run -i alpine cat",
    ]) {
      expect(action(cmd), cmd).toBeNull();
    }
    expect(
      action("docker run --mount type=bind,source=/work/repo/src,target=/s alpine sh"),
    ).toBeNull();
    expect(action("docker run -v C:\\work\\repo\\src:/s alpine sh", win)).toBeNull();
  });

  it("still catches the credential files a container would carry out", () => {
    // `docker cp` names ordinary files, so the existing secrets rules see them.
    const withHome = { ...posix, codedenHome: "/home/me/.codeden" };
    expect(action("docker cp /home/me/.codeden/install-token c:/t", withHome)).toBe("secrets");
  });

  it("leaves the rest of the classifier alone", () => {
    expect(action("echo hi > out.txt")).toBeNull();
    expect(action("echo hi > /outside/x")).toBe("outside_worktree");
    expect(action("dockerfile-lint .")).toBeNull();
  });
});
