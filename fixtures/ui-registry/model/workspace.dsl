workspace "Tags" {
  model {
    user = person "User"
    tags = softwareSystem "Tags" {
      web = container "Tags Web" "Lists and edits tags" "React" {
        tags "UI"
      }
    }
    user -> web "Edits tags" "HTTPS" {
      properties {
        "d.interaction" "sync"
      }
    }
  }
}
