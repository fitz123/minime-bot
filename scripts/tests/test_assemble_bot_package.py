from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "assemble_bot_package.py"
SPEC = importlib.util.spec_from_file_location("assemble_bot_package", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
ASSEMBLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ASSEMBLER)


def write(path: Path, content: str, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    path.chmod(mode)


def package(
    modules: Path,
    name: str,
    *,
    dependencies: dict[str, str] | None = None,
    optional_dependencies: dict[str, str] | None = None,
    peer_dependencies: dict[str, str] | None = None,
    peer_dependencies_meta: dict[str, object] | None = None,
    source: str = "export default true;\n",
) -> Path:
    root = modules.joinpath(*name.split("/"))
    root.mkdir(parents=True, mode=0o755)
    root.chmod(0o755)
    write(
        root / "package.json",
        json.dumps(
            {
                "name": name,
                "version": "1.0.0",
                "type": "module",
                "dependencies": dependencies or {},
                "optionalDependencies": optional_dependencies or {},
                "peerDependencies": peer_dependencies or {},
                "peerDependenciesMeta": peer_dependencies_meta or {},
            }
        )
        + "\n",
    )
    write(root / "index.js", source)
    return root


class AssembleBotPackageTests(unittest.TestCase):
    def test_assembles_and_executes_complete_hoisted_dependency_closure(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            modules = root / "node_modules"
            modules.mkdir()
            bot = package(
                modules,
                "minime-bot",
                dependencies={"fixture-dep": "1.0.0"},
                optional_dependencies={
                    "installed-optional": "1.0.0",
                    "missing-optional": "1.0.0",
                },
                peer_dependencies={
                    "installed-peer": "1.0.0",
                    "missing-optional-peer": "1.0.0",
                },
                peer_dependencies_meta={
                    "missing-optional-peer": {"optional": True},
                },
            )
            write(
                bot / "dist/main.js",
                'import value from "fixture-dep";\n'
                'import optional from "installed-optional";\n'
                'import peer from "installed-peer";\n'
                'if (`${value}:${optional}:${peer}` !== '
                '"closure-ok:optional-ok:peer-ok") throw new Error("bad closure");\n',
            )
            write(bot / "scripts/start-bot.sh", "#!/bin/bash\n", 0o755)
            package(
                modules,
                "fixture-dep",
                dependencies={"nested-dep": "1.0.0"},
                source='import value from "nested-dep"; export default value;\n',
            )
            package(
                modules,
                "nested-dep",
                source='export default "closure-ok";\n',
            )
            package(
                modules,
                "installed-optional",
                source='export default "optional-ok";\n',
            )
            package(
                modules,
                "installed-peer",
                source='export default "peer-ok";\n',
            )

            destination = root / "assembled"
            ASSEMBLER.assemble(bot, destination)

            self.assertTrue(
                (destination / "node_modules/fixture-dep/index.js").is_file()
            )
            self.assertTrue(
                (destination / "node_modules/nested-dep/index.js").is_file()
            )
            self.assertTrue(
                (destination / "node_modules/installed-optional/index.js").is_file()
            )
            self.assertTrue(
                (destination / "node_modules/installed-peer/index.js").is_file()
            )
            node = shutil.which("node")
            self.assertIsNotNone(node)
            result = subprocess.run(
                [str(node), str(destination / "dist/main.js")],
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_missing_dependencies_and_symlinks(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            modules = root / "node_modules"
            modules.mkdir()
            missing = package(
                modules,
                "minime-bot",
                dependencies={"missing": "1.0.0"},
            )
            write(missing / "dist/main.js", "export {};\n")
            write(missing / "scripts/start-bot.sh", "#!/bin/bash\n", 0o755)
            with self.assertRaises(ASSEMBLER.AssemblyError):
                ASSEMBLER.assemble(missing, root / "missing-output")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            modules = root / "node_modules"
            modules.mkdir()
            bot = package(modules, "minime-bot")
            write(bot / "dist/main.js", "export {};\n")
            write(bot / "scripts/start-bot.sh", "#!/bin/bash\n", 0o755)
            (bot / "dist/alias.js").symlink_to("main.js")
            with self.assertRaises(ASSEMBLER.AssemblyError):
                ASSEMBLER.assemble(bot, root / "symlink-output")


if __name__ == "__main__":
    unittest.main()
