import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics


func displayBox(_ value: String) -> PDFDisplayBox? {
    switch value {
    case "media": return .mediaBox
    case "crop": return .cropBox
    case "bleed": return .bleedBox
    case "trim": return .trimBox
    case "art": return .artBox
    default: return nil
    }
}

func cgRect(_ value: MutationRectangle) -> CGRect {
    CGRect(x: value.x, y: value.y, width: value.width, height: value.height)
}

func containedInMediaBox(_ rect: CGRect, page: PDFPage) -> Bool {
    let media = page.bounds(for: .mediaBox)
    return media.contains(rect) && !rect.isNull && !rect.isInfinite
}

func mutationCanApply(_ mutation: Mutation, document: PDFDocument, limits: Limits) -> Bool {
    guard !document.isLocked else { return false }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex), page.annotations.count <= limits.maxAnnotationsPerPage else {
            return false
        }
    }
    if let patch = mutation.metadata {
        let observed = metadata(document)
        guard observed.title != patch.title || observed.author != patch.author
                || observed.subject != patch.subject || observed.keywords != patch.keywords else { return false }
    }
    if mutation.metadata != nil || mutation.pageBox != nil || mutation.rotation != nil {
        guard document.allowsDocumentChanges else { return false }
    }
    if !mutation.annotations.isEmpty { guard document.allowsCommenting else { return false } }
    if let pageBox = mutation.pageBox {
        guard pageBox.page <= document.pageCount, let page = document.page(at: pageBox.page - 1),
              let box = displayBox(pageBox.box) else { return false }
        let rect = cgRect(pageBox.rect)
        guard !closeEnough(page.bounds(for: box), rect) else { return false }
        if box == .mediaBox {
            guard rect.width > 0 && rect.height > 0 else { return false }
        } else if !containedInMediaBox(rect, page: page) { return false }
    }
    if let rotation = mutation.rotation {
        guard rotation.page <= document.pageCount,
              let page = document.page(at: rotation.page - 1),
              page.rotation != rotation.degrees
        else { return false }
    }
    for edit in mutation.annotations {
        guard edit.page <= document.pageCount, let page = document.page(at: edit.page - 1),
              containedInMediaBox(cgRect(edit.rect), page: page) else { return false }
        // PDFKit persists a Text note together with a Popup annotation.
        let addedAnnotationCount = edit.subtype == "text" ? 2 : 1
        guard page.annotations.count + addedAnnotationCount <= limits.maxAnnotationsPerPage,
              page.annotations.count + addedAnnotationCount <= maximumAnnotationsPerPage else { return false }
    }
    return true
}

func pageRotationSnapshot(
    _ mutation: Mutation,
    document: PDFDocument,
    limits: Limits
) -> PageRotationSnapshot? {
    guard let rotation = mutation.rotation,
          !document.isLocked,
          document.pageCount >= 1,
          document.pageCount <= limits.maxPages,
          rotation.page <= document.pageCount,
          rawLocalGoToGraphIsSafe(document, limits: limits)
    else { return nil }
    var pageBoxes: [PageBoxes] = []
    var pageRotations: [Int] = []
    var annotationCounts: [Int] = []
    var annotationSubtypes: [[String]] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage
        else { return nil }
        pageBoxes.append(localGoToPageBoxes(page))
        pageRotations.append(page.rotation)
        annotationCounts.append(page.annotations.count)
        annotationSubtypes.append(page.annotations.map(annotationSubtype))
    }
    return PageRotationSnapshot(
        pageCount: document.pageCount,
        pageBoxes: pageBoxes,
        pageRotations: pageRotations,
        annotationCounts: annotationCounts,
        annotationSubtypes: annotationSubtypes
    )
}

func pageBoxSnapshot(
    _ mutation: Mutation,
    document: PDFDocument,
    limits: Limits
) -> PageBoxMutationSnapshot? {
    guard let pageBox = mutation.pageBox,
          ["crop", "bleed"].contains(pageBox.box),
          !document.isLocked,
          document.pageCount >= 1,
          document.pageCount <= limits.maxPages,
          pageBox.page <= document.pageCount,
          let selectedPage = document.page(at: pageBox.page - 1),
          let selectedBox = displayBox(pageBox.box),
          validMutationRectangle(pageBox.rect),
          containedInMediaBox(cgRect(pageBox.rect), page: selectedPage),
          !closeEnough(selectedPage.bounds(for: selectedBox), cgRect(pageBox.rect)),
          pageBox.box != "bleed" || cgRect(pageBox.rect).contains(selectedPage.bounds(for: .trimBox)),
          rawLocalGoToGraphIsSafe(document, limits: limits)
    else { return nil }
    var pageBoxes: [PageBoxes] = []
    var pageRotations: [Int] = []
    var annotationCounts: [Int] = []
    var annotationSubtypes: [[String]] = []
    var annotationDescriptors: [[CropAnnotationDescriptor]] = []
    let descriptorBudget = RawDescriptorTraversalBudget(rejectStreams: pageBox.box == "crop")
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage,
              let descriptors = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget)
        else { return nil }
        pageBoxes.append(localGoToPageBoxes(page))
        pageRotations.append(page.rotation)
        annotationCounts.append(page.annotations.count)
        annotationSubtypes.append(page.annotations.map(annotationSubtype))
        annotationDescriptors.append(descriptors)
    }
    return PageBoxMutationSnapshot(
        pageCount: document.pageCount,
        pageBoxes: pageBoxes,
        pageRotations: pageRotations,
        annotationCounts: annotationCounts,
        annotationSubtypes: annotationSubtypes,
        annotationDescriptors: annotationDescriptors
    )
}

func applyPageRotation(_ edit: PageRotationEdit, document: PDFDocument) -> Bool {
    guard let page = document.page(at: edit.page - 1) else { return false }
    page.rotation = edit.degrees
    return page.rotation == edit.degrees
}

func verifiesPageRotation(
    _ mutation: Mutation,
    document: PDFDocument,
    snapshot: PageRotationSnapshot,
    limits: Limits
) -> Bool {
    guard let rotation = mutation.rotation,
          document.pageCount == snapshot.pageCount,
          snapshot.pageBoxes.count == document.pageCount,
          snapshot.pageRotations.count == document.pageCount,
          snapshot.annotationCounts.count == document.pageCount,
          snapshot.annotationSubtypes.count == document.pageCount,
          rawLocalGoToGraphIsSafe(document, limits: limits)
    else { return false }
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.annotations.count == snapshot.annotationCounts[pageIndex],
              page.annotations.map(annotationSubtype) == snapshot.annotationSubtypes[pageIndex]
        else { return false }
        let expectedRotation = pageIndex == rotation.page - 1 ? rotation.degrees : snapshot.pageRotations[pageIndex]
        guard page.rotation == expectedRotation else { return false }
    }
    return true
}

func verifiesPageBox(
    _ mutation: Mutation,
    document: PDFDocument,
    snapshot: PageBoxMutationSnapshot,
    limits: Limits
) -> Bool {
    guard let pageBox = mutation.pageBox,
          ["crop", "bleed"].contains(pageBox.box),
          document.pageCount == snapshot.pageCount,
          snapshot.pageBoxes.count == document.pageCount,
          snapshot.pageRotations.count == document.pageCount,
          snapshot.annotationCounts.count == document.pageCount,
          snapshot.annotationSubtypes.count == document.pageCount,
          snapshot.annotationDescriptors.count == document.pageCount,
          rawLocalGoToGraphIsSafe(document, limits: limits)
    else { return false }
    let expectedPageBox = rectangle(cgRect(pageBox.rect))
    let descriptorBudget = RawDescriptorTraversalBudget(rejectStreams: pageBox.box == "crop")
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex) else { return false }
        let observedBoxes = localGoToPageBoxes(page)
        guard let annotationDescriptors = cropAnnotationDescriptors(document, pageIndex: pageIndex, budget: descriptorBudget),
              annotationDescriptors == snapshot.annotationDescriptors[pageIndex]
        else { return false }
        if pageIndex == pageBox.page - 1 {
            switch pageBox.box {
            case "crop":
                guard observedBoxes.media == snapshot.pageBoxes[pageIndex].media,
                      observedBoxes.crop == expectedPageBox,
                      observedBoxes.bleed == snapshot.pageBoxes[pageIndex].bleed,
                      observedBoxes.trim == snapshot.pageBoxes[pageIndex].trim,
                      observedBoxes.art == snapshot.pageBoxes[pageIndex].art
                else { return false }
            case "bleed":
                guard observedBoxes.media == snapshot.pageBoxes[pageIndex].media,
                      observedBoxes.crop == snapshot.pageBoxes[pageIndex].crop,
                      observedBoxes.bleed == expectedPageBox,
                      observedBoxes.trim == snapshot.pageBoxes[pageIndex].trim,
                      observedBoxes.art == snapshot.pageBoxes[pageIndex].art
                else { return false }
            default:
                return false
            }
        } else if observedBoxes != snapshot.pageBoxes[pageIndex] {
            return false
        }
        guard page.rotation == snapshot.pageRotations[pageIndex],
              page.annotations.count == snapshot.annotationCounts[pageIndex],
              page.annotations.map(annotationSubtype) == snapshot.annotationSubtypes[pageIndex]
        else { return false }
    }
    return true
}
