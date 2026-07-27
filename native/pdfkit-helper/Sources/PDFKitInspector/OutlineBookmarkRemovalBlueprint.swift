import Foundation
import PDFKit
import CoreGraphics

private let outlineRemovalItemKeys: Set<String> = [
    "Title", "Parent", "Prev", "Next", "First", "Last", "Count", "Dest",
]

private func rawOutlineRemovalDestination(
    _ item: CGPDFDictionaryRef,
    document: CGPDFDocument
) -> OutlineRemovalDestination? {
    guard !dictionaryContainsObject(item, key: "A"),
          !dictionaryContainsObject(item, key: "AA")
    else { return nil }
    var destination: CGPDFArrayRef?
    guard CGPDFDictionaryGetArray(item, "Dest", &destination),
          let destination,
          CGPDFArrayGetCount(destination) >= 2
    else { return nil }
    var pageDictionary: CGPDFDictionaryRef?
    var mode: UnsafePointer<CChar>?
    guard CGPDFArrayGetDictionary(destination, 0, &pageDictionary),
          let pageDictionary,
          CGPDFArrayGetName(destination, 1, &mode),
          let mode
    else { return nil }
    var targetPage = 0
    for page in 1...document.numberOfPages where document.page(at: page)?.dictionary == pageDictionary {
        targetPage = page
        break
    }
    guard targetPage > 0 else { return nil }
    switch String(cString: mode) {
    case "XYZ":
        var x: CGPDFReal = 0
        var y: CGPDFReal = 0
        var zoom: CGPDFObjectRef?
        guard CGPDFArrayGetCount(destination) == 5,
              CGPDFArrayGetNumber(destination, 2, &x),
              CGPDFArrayGetNumber(destination, 3, &y),
              x.isFinite,
              y.isFinite,
              CGPDFArrayGetObject(destination, 4, &zoom),
              let zoom,
              CGPDFObjectGetType(zoom) == .null
        else { return nil }
        return OutlineRemovalDestination(
            page: targetPage,
            mode: "XYZ",
            x: Double(x),
            y: Double(y)
        )
    default:
        return nil
    }
}

private func outlineRemovalDestinationMatches(
    _ raw: OutlineRemovalDestination,
    _ destination: PDFDestination,
    in document: PDFDocument
) -> Bool {
    guard let page = destination.page, document.index(for: page) + 1 == raw.page else {
        return false
    }
    switch raw.mode {
    case "XYZ":
        guard let x = raw.x, let y = raw.y else { return false }
        return closeEnough(destination.point.x, CGFloat(x))
            && closeEnough(destination.point.y, CGFloat(y))
    default:
        return false
    }
}

func outlineRemovalBlueprint(_ document: PDFDocument, limits: Limits) -> OutlineRemovalBlueprint? {
    guard let documentRef = document.documentRef,
          let catalog = documentRef.catalog,
          let policies = rawOutlinePolicies(document, limits: limits)
    else { return nil }
    guard dictionaryContainsObject(catalog, key: "Outlines") else {
        return document.outlineRoot == nil && policies.isEmpty
            ? OutlineRemovalBlueprint(nodes: [], itemCount: 0)
            : nil
    }
    var rawRoot: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &rawRoot),
          let rawRoot,
          dictionaryContainsOnlyKeys(rawRoot, allowed: ["Type", "First", "Last", "Count"]),
          !dictionaryContainsObject(rawRoot, key: "A"),
          !dictionaryContainsObject(rawRoot, key: "AA"),
          let root = document.outlineRoot
    else { return nil }
    guard root.numberOfChildren > 0 else {
        return policies.isEmpty ? OutlineRemovalBlueprint(nodes: [], itemCount: 0) : nil
    }
    var rawFirst: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(rawRoot, "First", &rawFirst), let rawFirst else {
        return nil
    }
    var itemCount = 0
    func children(
        rawInitial: CGPDFDictionaryRef,
        parent: PDFOutline,
        depth: Int,
        prefix: String
    ) -> [OutlineRemovalNode]? {
        guard depth < limits.maxOutlineDepth else { return nil }
        var rawCurrent: CGPDFDictionaryRef? = rawInitial
        var result: [OutlineRemovalNode] = []
        var index = 0
        while let rawItem = rawCurrent {
            guard dictionaryContainsOnlyKeys(rawItem, allowed: outlineRemovalItemKeys),
                  itemCount < limits.maxOutlineItems,
                  index < parent.numberOfChildren,
                  let item = parent.child(at: index)
            else { return nil }
            itemCount += 1
            let path = prefix.isEmpty ? String(index) : "\(prefix).\(index)"
            guard let policy = policies[path],
                  case .directDestination = policy.action,
                  let title = item.label,
                  title == policy.title,
                  title.utf8.count <= maximumStringLength,
                  let destination = item.destination,
                  let rawDestination = rawOutlineRemovalDestination(rawItem, document: documentRef),
                  outlineRemovalDestinationMatches(rawDestination, destination, in: document)
            else { return nil }
            let childNodes: [OutlineRemovalNode]
            if dictionaryContainsObject(rawItem, key: "First") {
                var rawChild: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(rawItem, "First", &rawChild),
                      let rawChild,
                      let nested = children(
                          rawInitial: rawChild,
                          parent: item,
                          depth: depth + 1,
                          prefix: path
                      )
                else { return nil }
                childNodes = nested
            } else {
                guard item.numberOfChildren == 0 else { return nil }
                childNodes = []
            }
            result.append(OutlineRemovalNode(
                label: title,
                labelSHA256: sha256Hex(Data(title.utf8)),
                isOpen: item.isOpen,
                destination: rawDestination,
                children: childNodes
            ))
            if dictionaryContainsObject(rawItem, key: "Next") {
                var rawNext: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(rawItem, "Next", &rawNext), let rawNext else {
                    return nil
                }
                rawCurrent = rawNext
            } else {
                rawCurrent = nil
            }
            index += 1
        }
        return index == parent.numberOfChildren ? result : nil
    }
    guard let nodes = children(rawInitial: rawFirst, parent: root, depth: 0, prefix: ""),
          itemCount == policies.count,
          itemCount < limits.maxOutlineItems
    else { return nil }
    return OutlineRemovalBlueprint(nodes: nodes, itemCount: itemCount)
}

func installOutlineMutationNodes(
    _ nodes: [OutlineRemovalNode],
    in parent: PDFOutline,
    document: PDFDocument
) -> Bool {
    for node in nodes {
        guard node.destination.mode == "XYZ",
              let x = node.destination.x,
              let y = node.destination.y,
              let page = document.page(at: node.destination.page - 1)
        else { return false }
        let item = PDFOutline()
        item.label = node.label
        item.isOpen = node.isOpen
        item.destination = PDFDestination(page: page, at: CGPoint(x: x, y: y))
        guard installOutlineMutationNodes(node.children, in: item, document: document) else {
            return false
        }
        parent.insertChild(item, at: parent.numberOfChildren)
    }
    return true
}
