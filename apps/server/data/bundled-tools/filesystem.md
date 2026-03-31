---
name: Filesystem
description: Read, write, and manage files on the local filesystem
version: 1.0.0
category: file
icon: folder
mcp:
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "{{homedir}}", "{{cwd}}", "{{tmp}}"]
  transport: stdio
inputs:
  - name: path
    type: string
    description: File or directory path
    required: true
  - name: operation
    type: string
    description: "Operation: read, write, list, search"
    required: true
---
You have access to filesystem tools for managing local files.

Available operations:
- **read_file**: Read the contents of a file
- **write_file**: Write content to a file
- **list_directory**: List files and folders in a directory
- **search_files**: Search for files by name pattern

Always confirm before writing or modifying files. Be careful with file paths.
