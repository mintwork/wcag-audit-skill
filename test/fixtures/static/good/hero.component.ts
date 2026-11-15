import { Component, input } from "@angular/core";

// A clean Angular component with an inline template (must produce zero findings).
@Component({
  selector: "app-hero",
  standalone: true,
  template: `
    <h2>{{ hero().name }}</h2>
    <img [src]="hero().photo" [alt]="hero().name" />
    <label for="nickname">Nickname</label>
    <input id="nickname" type="text" [(ngModel)]="nickname" />
    <button type="button" (click)="save()">Save</button>
    <button type="button" pButton label="Delete" icon="pi pi-trash" (click)="remove()"></button>
    <div ngListbox (click)="pick()" [tabIndex]="-1">Options</div>
    @if (hero().bio) {
      <p>{{ hero().bio }}</p>
    }
  `,
})
export class HeroComponent {
  hero = input.required<{ name: string; photo: string; bio?: string }>();
  nickname = "";
  html = "<img src='not-markup.png'>";
  save() {}
  remove() {}
  pick() {}
}
