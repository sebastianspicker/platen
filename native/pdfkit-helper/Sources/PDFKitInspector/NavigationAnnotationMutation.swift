import Foundation
import PDFKit
import AppKit
import Darwin
import CryptoKit
import CoreGraphics


func localGoToPageBoxes(_ page: PDFPage) -> PageBoxes {
    PageBoxes(
        media: rectangle(page.bounds(for: .mediaBox)), crop: rectangle(page.bounds(for: .cropBox)),
        bleed: rectangle(page.bounds(for: .bleedBox)), trim: rectangle(page.bounds(for: .trimBox)),
        art: rectangle(page.bounds(for: .artBox))
    )
}

private func localGoToSnapshot(
    _ request: LocalGoToRequest,
    document: PDFDocument
) -> LocalGoToSnapshot? {
    guard !document.isLocked, document.allowsCommenting, document.allowsDocumentChanges,
          document.pageCount >= 1, document.pageCount <= request.limits.maxPages,
          request.link.sourcePage <= document.pageCount, request.link.targetPage <= document.pageCount,
          let sourcePage = document.page(at: request.link.sourcePage - 1),
          let targetPage = document.page(at: request.link.targetPage - 1),
          sourcePage.annotations.count < request.limits.maxAnnotationsPerPage,
          sourcePage.annotations.count < maximumAnnotationsPerPage,
          targetPage.bounds(for: .cropBox).width > 0, targetPage.bounds(for: .cropBox).height > 0,
          !targetPage.bounds(for: .cropBox).isNull, !targetPage.bounds(for: .cropBox).isInfinite,
          sourcePage.bounds(for: .cropBox).contains(cgRect(request.link.rect)),
          rawLocalGoToGraphIsSafe(document, limits: request.limits)
    else { return nil }
    var pageBoxes: [PageBoxes] = []
    var rotations: [Int] = []
    var annotationCounts: [Int] = []
    var annotationSubtypes: [[String]] = []
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              page.annotations.count <= request.limits.maxAnnotationsPerPage,
              page.annotations.count <= maximumAnnotationsPerPage
        else { return nil }
        pageBoxes.append(localGoToPageBoxes(page))
        rotations.append(page.rotation)
        annotationCounts.append(page.annotations.count)
        annotationSubtypes.append(page.annotations.map(annotationSubtype))
    }
    return LocalGoToSnapshot(
        pageCount: document.pageCount, pageBoxes: pageBoxes, pageRotations: rotations,
        annotationCounts: annotationCounts, annotationSubtypes: annotationSubtypes
    )
}

private func applyLocalGoTo(
    _ link: LocalGoToLink,
    document: PDFDocument
) -> RawLocalGoToDestination? {
    guard let sourcePage = document.page(at: link.sourcePage - 1),
          let targetPage = document.page(at: link.targetPage - 1) else { return nil }
    let crop = targetPage.bounds(for: .cropBox)
    let point = CGPoint(x: crop.minX, y: crop.maxY)
    let destination = PDFDestination(page: targetPage, at: point)
    let annotation = PDFAnnotation(bounds: cgRect(link.rect), forType: .link, withProperties: nil)
    guard annotation.setValue(destination, forAnnotationKey: .destination) else { return nil }
    sourcePage.addAnnotation(annotation)
    return RawLocalGoToDestination(page: link.targetPage, x: point.x, y: point.y)
}

private func verifiesLocalGoTo(
    _ request: LocalGoToRequest,
    document: PDFDocument,
    snapshot: LocalGoToSnapshot,
    destination: RawLocalGoToDestination
) -> Int? {
    guard document.pageCount == snapshot.pageCount,
          snapshot.pageBoxes.count == document.pageCount,
          snapshot.pageRotations.count == document.pageCount,
          snapshot.annotationCounts.count == document.pageCount,
          snapshot.annotationSubtypes.count == document.pageCount
    else { return nil }
    let newAnnotationIndex = snapshot.annotationCounts[request.link.sourcePage - 1]
    for pageIndex in 0..<document.pageCount {
        guard let page = document.page(at: pageIndex),
              localGoToPageBoxes(page) == snapshot.pageBoxes[pageIndex],
              page.rotation == snapshot.pageRotations[pageIndex]
        else { return nil }
        let expectedCount = snapshot.annotationCounts[pageIndex]
            + (pageIndex == request.link.sourcePage - 1 ? 1 : 0)
        guard page.annotations.count == expectedCount else { return nil }
        let observedSubtypes = page.annotations.map(annotationSubtype)
        let expectedSubtypes = snapshot.annotationSubtypes[pageIndex]
            + (pageIndex == request.link.sourcePage - 1 ? ["link"] : [])
        guard observedSubtypes == expectedSubtypes else { return nil }
    }
    guard let sourcePage = document.page(at: request.link.sourcePage - 1),
          newAnnotationIndex < sourcePage.annotations.count else { return nil }
    let annotation = sourcePage.annotations[newAnnotationIndex]
    let inventory = inspectLink(annotation, annotationIndex: newAnnotationIndex, document: document)
    guard annotationSubtype(annotation) == "link",
          closeEnough(annotation.bounds, cgRect(request.link.rect)),
          annotation.contents == nil,
          inventory.kind == "goTo", inventory.targetPage == request.link.targetPage,
          inventory.target == nil, inventory.remotePage == nil,
          annotation.action is PDFActionGoTo,
          rawLocalGoToGraphIsSafe(
              document,
              limits: request.limits,
              allowing: AllowedRawLocalGoTo(
                  page: request.link.sourcePage,
                  annotationIndex: newAnnotationIndex,
                  destination: destination
              )
          )
    else { return nil }
    return newAnnotationIndex
}

func addLocalGoToLink(
    _ request: LocalGoToRequest,
    workspace: URL,
    inputData: Data
) throws -> LocalGoToReceipt {
    let sourceDigest = sha256Hex(inputData)
    guard sourceDigest == request.sourceSha256,
          let document = PDFDocument(data: inputData),
          let snapshot = localGoToSnapshot(request, document: document),
          let destination = applyLocalGoTo(request.link, document: document),
          let outputData = document.dataRepresentation(), outputData.count <= maxOutputBytes,
          let candidate = PDFDocument(data: outputData),
          verifiesLocalGoTo(request, document: candidate, snapshot: snapshot, destination: destination) != nil
    else { throw InspectionFailure.mutationFailed }
    let output = workspace.appendingPathComponent(request.outputFilename)
    try writePrivateOutput(outputData, to: output)
    let reopenedData = try readPrivateInput(output)
    guard let reopened = PDFDocument(data: reopenedData),
          let annotationIndex = verifiesLocalGoTo(
              request, document: reopened, snapshot: snapshot, destination: destination
          )
    else { throw InspectionFailure.outputInvalid }
    let outputDigest = sha256Hex(reopenedData)
    guard outputDigest != sourceDigest else { throw InspectionFailure.outputInvalid }
    return LocalGoToReceipt(
        sourceSha256: sourceDigest,
        outputSha256: outputDigest,
        sourcePage: request.link.sourcePage,
        targetPage: request.link.targetPage,
        annotationIndex: annotationIndex,
        pageCount: reopened.pageCount
    )
}
