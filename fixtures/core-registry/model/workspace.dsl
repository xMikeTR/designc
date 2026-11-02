workspace {
  model {
    s = softwareSystem "Tags" {
      ui = container "Tags UI" { tags "UI" }
      api = container "Tags API"
      db = container "Tags DB"
    }
    ui -> api "Lists tags" { properties { "d.interaction" "sync" } }
    api -> db "Reads tags" { properties { "d.interaction" "sync" } }
  }
}
