import Foundation
import PDFKit
import CoreGraphics


enum RawOutlineActionPolicy {
    case directDestination
    case goToAction
    case unsafe
}

struct RawOutlinePolicy {
    let title: String?
    let action: RawOutlineActionPolicy
}

func rawOutlinePolicies(_ document: PDFDocument, limits: Limits) -> [String: RawOutlinePolicy]? {
    guard let catalog = document.documentRef?.catalog else { return nil }
    guard dictionaryContainsObject(catalog, key: "Outlines") else { return [:] }
    var root: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(catalog, "Outlines", &root), let root,
          !dictionaryContainsObject(root, key: "A"), !dictionaryContainsObject(root, key: "AA")
    else { return nil }
    guard dictionaryContainsObject(root, key: "First") else { return [:] }
    var first: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(root, "First", &first), let first else { return nil }

    var remaining = limits.maxOutlineItems
    var policies: [String: RawOutlinePolicy] = [:]
    func visit(_ initial: CGPDFDictionaryRef, depth: Int, prefix: String) -> Bool {
        guard depth < limits.maxOutlineDepth else { return true }
        var current: CGPDFDictionaryRef? = initial
        var sibling = 0
        while let item = current, remaining > 0 {
            remaining -= 1
            let path = prefix.isEmpty ? String(sibling) : "\(prefix).\(sibling)"
            let actionPolicy: RawOutlineActionPolicy
            if dictionaryContainsObject(item, key: "AA") {
                actionPolicy = .unsafe
            } else if dictionaryContainsObject(item, key: "A") {
                var action: CGPDFDictionaryRef?
                if dictionaryContainsObject(item, key: "Dest")
                    || !CGPDFDictionaryGetDictionary(item, "A", &action)
                    || action == nil
                    || pdfName(action!, key: "S") != "GoTo"
                    || !dictionaryContainsOnlyKeys(action!, allowed: ["Type", "S", "D"]) {
                    actionPolicy = .unsafe
                } else {
                    actionPolicy = .goToAction
                }
            } else {
                actionPolicy = .directDestination
            }
            policies[path] = RawOutlinePolicy(title: pdfTextString(item, key: "Title"), action: actionPolicy)

            if dictionaryContainsObject(item, key: "First") {
                var child: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(item, "First", &child), let child,
                      visit(child, depth: depth + 1, prefix: path)
                else { return false }
            }
            if dictionaryContainsObject(item, key: "Next") {
                var next: CGPDFDictionaryRef?
                guard CGPDFDictionaryGetDictionary(item, "Next", &next), let next else { return false }
                current = next
            } else {
                current = nil
            }
            sibling += 1
        }
        return true
    }
    return visit(first, depth: 0, prefix: "") ? policies : nil
}

func inspectOutline(_ document: PDFDocument, limits: Limits, sourceDigest: String? = nil) -> OutlineInventory {
    var itemCount = 0
    var truncated = false
    let rawPolicies = rawOutlinePolicies(document, limits: limits)
    let removalBlueprint = sourceDigest.flatMap { _ in outlineRemovalBlueprint(document, limits: limits) }
    var rawStructureMatches = rawPolicies != nil
    func children(of outline: PDFOutline, depth: Int, prefix: String) -> [OutlineItem] {
        guard depth < limits.maxOutlineDepth else {
            if outline.numberOfChildren > 0 { truncated = true }
            return []
        }
        var result: [OutlineItem] = []
        for index in 0..<outline.numberOfChildren {
            guard itemCount < limits.maxOutlineItems else { truncated = true; break }
            guard let child = outline.child(at: index) else { continue }
            itemCount += 1
            let path = prefix.isEmpty ? String(index) : "\(prefix).\(index)"
            let title = boundedString(child.label)
            let rawPolicy = rawPolicies?[path]
            if rawPolicy?.title != title { rawStructureMatches = false }
            let resolvedPage: Int?
            if let rawPolicy {
                resolvedPage = outlinePage(child, in: document, policy: rawPolicy.action)
            } else {
                resolvedPage = nil
            }
            let locator = depth == 0 && !truncated ? sourceDigest.flatMap { digest in
                removalBlueprint?.locator(sourceDigest: digest, topLevelIndex: index)
            } : nil
            result.append(OutlineItem(
                title: title,
                page: resolvedPage,
                children: children(of: child, depth: depth + 1, prefix: path),
                removalLocator: locator
            ))
        }
        return result
    }
    guard let root = document.outlineRoot else { return OutlineInventory(items: [], truncated: false) }
    let items = children(of: root, depth: 0, prefix: "")
    if rawPolicies?.count != itemCount { rawStructureMatches = false }
    func withoutNavigation(_ entries: [OutlineItem]) -> [OutlineItem] {
        entries.map {
            OutlineItem(title: $0.title, page: nil, children: withoutNavigation($0.children), removalLocator: nil)
        }
    }
    let canExposeLocators = rawStructureMatches && !truncated && removalBlueprint != nil && sourceDigest != nil
    func clearingLocators(_ entries: [OutlineItem]) -> [OutlineItem] {
        entries.map {
            OutlineItem(title: $0.title, page: $0.page, children: clearingLocators($0.children), removalLocator: nil)
        }
    }
    let inspected = rawStructureMatches ? items : withoutNavigation(items)
    return OutlineInventory(items: canExposeLocators ? inspected : clearingLocators(inspected), truncated: truncated)
}

func outlinePage(
    _ outline: PDFOutline,
    in document: PDFDocument,
    policy: RawOutlineActionPolicy
) -> Int? {
    switch policy {
    case .unsafe:
        return nil
    case .goToAction:
        guard let goTo = outline.action as? PDFActionGoTo else { return nil }
        return destinationPage(goTo.destination, in: document)
    case .directDestination:
        guard let destination = outline.destination else { return nil }
        return destinationPage(destination, in: document)
    }
}

func inspectPageLabels(_ document: PDFDocument, limits: Limits) -> PageLabelsInventory {
    let count = min(document.pageCount, limits.maxPages)
    let items = (0..<count).compactMap { index -> PageLabelItem? in
        guard let page = document.page(at: index) else { return nil }
        return PageLabelItem(page: index + 1, label: boundedString(page.label) ?? String(index + 1))
    }
    let present = document.documentRef?.catalog.map { dictionaryContainsObject($0, key: "PageLabels") } ?? false
    return PageLabelsInventory(present: present, items: items, truncated: document.pageCount > items.count)
}
